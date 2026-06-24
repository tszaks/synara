import {
  MemoryOverview,
  type MemoryOverviewInput,
  type MemoryStatus,
  type PalliumDoctorResult,
  type ProjectId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Ref, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PalliumCommandCacheRepository } from "../../persistence/Services/PalliumCommandCache.ts";
import { PalliumService } from "../../pallium/Services/PalliumService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { MemoryServiceError } from "../Errors.ts";
import { MemoryService, type MemoryServiceShape } from "../Services/MemoryService.ts";

// How long a memoized overview stays valid as a TTL backstop. The index_epoch key is the primary
// invalidation mechanism (a new index misses every old key for free); this only bounds staleness
// when the epoch happens to be identical (e.g. an index run that produced the same commit).
const OVERVIEW_CACHE_TTL_MS = 5 * 60_000;
// The cache `command` discriminator for overview rows. Keeps overview rows distinct from any other
// cached command for the same project.
const OVERVIEW_CACHE_COMMAND = "memory.overview";

// A zeroed, valid overview. Returned whenever Pallium is unavailable or no project is indexed, so
// read callers never throw.
const emptyOverview = (input: { readonly available: boolean }): MemoryOverview => ({
  available: input.available,
  indexStatus: "missing",
  indexed: false,
  workingTreeDirty: false,
  counts: {
    sessions: 0,
    events: 0,
    messages: 0,
    chunks: 0,
    embeddings: 0,
    workingTreeFiles: 0,
  },
  embeddingModels: [],
  embeddingBacklog: 0,
});

// Map a Pallium doctor report into the stable MemoryOverview WS shape.
const doctorToOverview = (doctor: PalliumDoctorResult): MemoryOverview => ({
  available: true,
  indexStatus: doctor.index_status,
  indexed: doctor.index_status === "indexed",
  ...(doctor.indexed_at !== undefined ? { lastIndexedAt: doctor.indexed_at } : {}),
  ...(doctor.last_indexed_commit !== undefined
    ? { lastIndexedCommit: doctor.last_indexed_commit }
    : {}),
  workingTreeDirty: doctor.working_tree_dirty,
  counts: {
    sessions: doctor.session_stats.sessions,
    events: doctor.session_stats.events,
    messages: doctor.session_stats.messages,
    chunks: doctor.session_stats.chunks,
    embeddings: doctor.session_stats.embeddings,
    workingTreeFiles: doctor.working_tree_file_count,
  },
  embeddingModels: (doctor.session_stats.models ?? []).map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    dim: entry.dim,
    count: entry.count,
  })),
  embeddingBacklog: doctor.embedding_backlog,
});

// The per-project cache key: the epoch token a doctor report describes. A change here misses every
// older cached row for free. Falls back to a constant so a repo with no recorded index still
// memoizes within the TTL window.
const epochFromDoctor = (doctor: PalliumDoctorResult): string =>
  doctor.last_indexed_commit ?? doctor.indexed_at ?? `status:${doctor.index_status}`;

export const MemoryServiceLive = Layer.effect(
  MemoryService,
  Effect.gen(function* () {
    const pallium = yield* PalliumService;
    const cache = yield* PalliumCommandCacheRepository;
    const projections = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;
    // Read so the dependency is wired now (settings gate Memory; future read methods consult it).
    void serverSettings;

    // Last index epoch we resolved per project. The durable SQLite cache is keyed BY epoch, so to
    // serve a repeat overview without re-spawning `doctor` (which is how we learn the live epoch)
    // we remember the last epoch in-process and try the cache with it first. A real index refresh
    // changes the epoch; the next miss re-probes doctor and re-learns it.
    const lastEpochByProject = yield* Ref.make(new Map<string, string>());

    const status: Effect.Effect<MemoryStatus, never> = pallium.status.pipe(
      Effect.map(
        (palliumStatus): MemoryStatus => ({
          available: palliumStatus.available,
          ...(palliumStatus.version !== undefined ? { version: palliumStatus.version } : {}),
          capabilities: palliumStatus.capabilities,
          checkedAt: palliumStatus.checkedAt,
          ...(palliumStatus.reason !== undefined ? { reason: palliumStatus.reason } : {}),
        }),
      ),
    );

    // Resolve a project id to its workspace root, or None if the project is unknown.
    const resolveRepoPath = (projectId: ProjectId) =>
      projections.getProjectShellById(projectId).pipe(
        Effect.map(Option.map((project) => project.workspaceRoot)),
        Effect.mapError(
          (cause) =>
            new MemoryServiceError({ message: "Failed to resolve memory project.", cause }),
        ),
      );

    const readCachedOverview = (projectId: ProjectId, indexEpoch: string, now: Date) =>
      cache
        .get({
          command: OVERVIEW_CACHE_COMMAND,
          args: "",
          projectId,
          indexEpoch,
          now: now.toISOString(),
        })
        .pipe(
          Effect.mapError(
            (cause) => new MemoryServiceError({ message: "Failed to read memory cache.", cause }),
          ),
          Effect.flatMap((cached) =>
            Option.isNone(cached)
              ? Effect.succeed(Option.none<MemoryOverview>())
              : Schema.decodeUnknownEffect(MemoryOverview)(cached.value.resultJson).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(
                    (cause) =>
                      new MemoryServiceError({
                        message: "Failed to decode cached overview.",
                        cause,
                      }),
                  ),
                ),
          ),
        );

    // Run pallium doctor for a repo and map it, memoizing by index epoch.
    //
    // A repeat overview call within the same epoch must NOT re-spawn the binary. Because the
    // durable cache is keyed by epoch (which `doctor` reports), we first try the cache with the
    // epoch we last learned for this project; on a hit we return without spawning `doctor` at all.
    // Only when there is no remembered epoch, or the cached row is gone/expired, do we probe
    // `doctor`, re-learn the epoch, and refill the cache.
    const overviewForRepo = (projectId: ProjectId, repoPath: string) =>
      Effect.gen(function* () {
        const now = new Date();
        const rememberedEpoch = yield* Ref.get(lastEpochByProject).pipe(
          Effect.map((map) => map.get(projectId)),
        );
        if (rememberedEpoch !== undefined) {
          const cached = yield* readCachedOverview(projectId, rememberedEpoch, now);
          if (Option.isSome(cached)) {
            return cached.value;
          }
        }

        const doctorResult = yield* pallium
          .doctor({ cwd: repoPath })
          .pipe(
            Effect.mapError(
              (cause) =>
                new MemoryServiceError({ message: "Failed to read memory overview.", cause }),
            ),
          );
        const indexEpoch = epochFromDoctor(doctorResult);

        // The epoch may have moved since we last remembered it (the repo was re-indexed). Try the
        // cache once more under the live epoch before re-mapping.
        const freshlyCached = yield* readCachedOverview(projectId, indexEpoch, now);
        if (Option.isSome(freshlyCached)) {
          yield* Ref.update(lastEpochByProject, (map) => new Map(map).set(projectId, indexEpoch));
          return freshlyCached.value;
        }

        const overview = doctorToOverview(doctorResult);
        const encoded = yield* Schema.encodeUnknownEffect(MemoryOverview)(overview).pipe(
          Effect.mapError(
            (cause) =>
              new MemoryServiceError({ message: "Failed to encode memory overview.", cause }),
          ),
        );
        yield* cache
          .put({
            command: OVERVIEW_CACHE_COMMAND,
            args: "",
            projectId,
            indexEpoch,
            argsJson: {},
            resultJson: encoded as never,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + OVERVIEW_CACHE_TTL_MS).toISOString(),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new MemoryServiceError({ message: "Failed to write memory cache.", cause }),
            ),
          );
        yield* Ref.update(lastEpochByProject, (map) => new Map(map).set(projectId, indexEpoch));
        return overview;
      });

    const overview = (input?: MemoryOverviewInput) =>
      Effect.gen(function* () {
        const palliumStatus = yield* pallium.status;
        if (!palliumStatus.available) {
          return emptyOverview({ available: false });
        }
        const projectId = input?.projectId;
        if (projectId === undefined) {
          // No project to scope to: return the available-but-empty overview. Per-project counts
          // need a repo path; the status already proved the binary works.
          return emptyOverview({ available: true });
        }
        const repoPathOption = yield* resolveRepoPath(projectId);
        if (Option.isNone(repoPathOption)) {
          return emptyOverview({ available: true });
        }
        return yield* overviewForRepo(projectId, repoPathOption.value);
      });

    return {
      status,
      overview,
    } satisfies MemoryServiceShape;
  }),
);
