import {
  MemoryDecisionList,
  type MemoryFile,
  MemoryFileList,
  type MemoryListDecisionsInput,
  type MemoryListFilesInput,
  type MemoryListSessionsInput,
  MemoryOverview,
  type MemoryOverviewInput,
  type MemorySearchInput,
  type MemorySearchResult,
  MemorySearchResultList,
  type MemorySession,
  MemorySessionList,
  type MemoryStatus,
  type PalliumChangedNowResult,
  type PalliumDecisionList,
  type PalliumDoctorResult,
  type PalliumSessionList,
  type PalliumSessionSearchList,
  ProjectId,
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

// Sessions and decisions are home-DB scoped, not repo-epoch scoped. They are cached by
// command+args with the TTL `expires_at` as the sole invalidation backstop, under a constant epoch.
const SESSIONS_CACHE_COMMAND = "memory.listSessions";
const DECISIONS_CACHE_COMMAND = "memory.listDecisions";
const SEARCH_CACHE_COMMAND = "memory.search";
const SESSIONS_CACHE_TTL_MS = 60_000;
const DECISIONS_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_TTL_MS = 60_000;
// A fixed epoch for non-repo-epoch-scoped cache rows (sessions). The cache key still requires an
// epoch, but for home-DB data there is no index epoch, so the TTL alone bounds staleness.
const HOME_DB_EPOCH = "home-db";
// A sentinel project id for cache rows that are not tied to a real project (the sessions list is
// global). The cache key requires a ProjectId; this keeps global rows out of any real project's
// namespace.
const GLOBAL_PROJECT_ID = ProjectId.makeUnsafe("memory:global");

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

// Map a Pallium changed-now report into the stable MemoryFileList shape. Lenient: a null/omitted
// files array (or null suggested_tests/blast_radius) folds into an empty array.
const changedNowToFileList = (report: PalliumChangedNowResult): MemoryFileList => ({
  available: true,
  files: (report.files ?? []).map(
    (file): MemoryFile => ({
      path: file.path,
      workingTreeStatus: file.working_tree_status,
      riskLevel: file.risk_level,
      suggestedTests: [...(file.suggested_tests ?? [])],
      blastRadius: [...(file.blast_radius ?? [])],
    }),
  ),
});

// Map a Pallium sessions list (top-level array) into the stable MemorySessionList shape.
const sessionsToSessionList = (sessions: PalliumSessionList): MemorySessionList => ({
  available: true,
  sessions: (sessions ?? []).map(
    (session): MemorySession => ({
      id: session.id,
      ...(session.title !== undefined ? { title: session.title } : {}),
      ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
      ...(session.source !== undefined ? { source: session.source } : {}),
      ...(session.model_provider !== undefined ? { modelProvider: session.model_provider } : {}),
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(session.git_branch !== undefined ? { gitBranch: session.git_branch } : {}),
      ...(session.created_at !== undefined ? { createdAt: session.created_at } : {}),
      ...(session.updated_at !== undefined ? { updatedAt: session.updated_at } : {}),
      ...(session.status !== undefined ? { status: session.status } : {}),
    }),
  ),
});

// Map a Pallium decisions list (top-level array) into the stable MemoryDecisionList shape.
const decisionsToDecisionList = (decisions: PalliumDecisionList): MemoryDecisionList => ({
  available: true,
  decisions: (decisions ?? []).map((decision) => ({
    ...(decision.source_type !== undefined ? { sourceType: decision.source_type } : {}),
    ...(decision.source_ref !== undefined ? { sourceRef: decision.source_ref } : {}),
    ...(decision.title !== undefined ? { title: decision.title } : {}),
    ...(decision.body !== undefined ? { body: decision.body } : {}),
    ...(decision.committed_at !== undefined ? { committedAt: decision.committed_at } : {}),
  })),
});

// Map a Pallium sessions-search list (top-level array of SearchResult) into the stable
// MemorySearchResultList shape. SearchResult embeds Session, so the session fields are flattened. A
// null/omitted signals array folds into an empty array; a negative/absent score is dropped (the
// contract's score is a NonNegativeInt).
const searchToResultList = (results: PalliumSessionSearchList): MemorySearchResultList => ({
  available: true,
  results: (results ?? []).map(
    (result): MemorySearchResult => ({
      id: result.id,
      ...(result.title !== undefined ? { title: result.title } : {}),
      ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
      ...(result.source !== undefined ? { source: result.source } : {}),
      ...(result.model_provider !== undefined ? { modelProvider: result.model_provider } : {}),
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.git_branch !== undefined ? { gitBranch: result.git_branch } : {}),
      ...(result.created_at !== undefined ? { createdAt: result.created_at } : {}),
      ...(result.updated_at !== undefined ? { updatedAt: result.updated_at } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.score !== undefined && result.score >= 0 ? { score: result.score } : {}),
      signals: [...(result.signals ?? [])],
    }),
  ),
});

// Empty, valid results returned whenever Pallium is unavailable or a project can't be resolved, so
// read callers never throw.
const emptyFileList = (available: boolean): MemoryFileList => ({ available, files: [] });
const emptySessionList = (available: boolean): MemorySessionList => ({ available, sessions: [] });
const emptyDecisionList = (available: boolean): MemoryDecisionList => ({
  available,
  decisions: [],
});
const emptySearchResultList = (available: boolean): MemorySearchResultList => ({
  available,
  results: [],
});

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

    // A generic, schema-checked cache read for a command+args row under a fixed epoch. Returns the
    // decoded contract value on a hit, or None on a miss / decode failure path. Used by the
    // home-DB-scoped read methods (sessions, decisions) whose only invalidation is the TTL.
    const readCachedResult = <A, I>(input: {
      readonly schema: Schema.Codec<A, I>;
      readonly command: string;
      readonly args: string;
      readonly projectId: ProjectId;
      readonly indexEpoch: string;
      readonly now: Date;
    }) =>
      cache
        .get({
          command: input.command,
          args: input.args,
          projectId: input.projectId,
          indexEpoch: input.indexEpoch,
          now: input.now.toISOString(),
        })
        .pipe(
          Effect.mapError(
            (cause) => new MemoryServiceError({ message: "Failed to read memory cache.", cause }),
          ),
          Effect.flatMap((cached) =>
            Option.isNone(cached)
              ? Effect.succeed(Option.none<A>())
              : Schema.decodeUnknownEffect(input.schema)(cached.value.resultJson).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(
                    (cause) =>
                      new MemoryServiceError({
                        message: "Failed to decode cached memory result.",
                        cause,
                      }),
                  ),
                ),
          ),
        );

    // A generic, schema-checked cache write under a fixed epoch with a TTL backstop.
    const writeCachedResult = <A, I>(input: {
      readonly schema: Schema.Codec<A, I>;
      readonly command: string;
      readonly args: string;
      readonly projectId: ProjectId;
      readonly indexEpoch: string;
      readonly value: A;
      readonly now: Date;
      readonly ttlMs: number;
    }) =>
      Schema.encodeUnknownEffect(input.schema)(input.value).pipe(
        Effect.mapError(
          (cause) => new MemoryServiceError({ message: "Failed to encode memory result.", cause }),
        ),
        Effect.flatMap((encoded) =>
          cache
            .put({
              command: input.command,
              args: input.args,
              projectId: input.projectId,
              indexEpoch: input.indexEpoch,
              argsJson: {},
              resultJson: encoded as never,
              createdAt: input.now.toISOString(),
              expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new MemoryServiceError({ message: "Failed to write memory cache.", cause }),
              ),
            ),
        ),
      );

    // listFiles maps `pallium changed-now`. It reflects the LIVE working tree (not the index), so it
    // is intentionally NOT cached: an index-epoch key would miss real working-tree edits and a TTL
    // would risk showing stale changes. Correctness over a re-spawn here.
    const listFiles = (input?: MemoryListFilesInput) =>
      Effect.gen(function* () {
        const palliumStatus = yield* pallium.status;
        if (!palliumStatus.available) {
          return emptyFileList(false);
        }
        const projectId = input?.projectId;
        if (projectId === undefined) {
          // No repo to inspect: there are no changed files to report.
          return emptyFileList(true);
        }
        const repoPathOption = yield* resolveRepoPath(projectId);
        if (Option.isNone(repoPathOption)) {
          return emptyFileList(true);
        }
        const report = yield* pallium
          .changedNow({ cwd: repoPathOption.value })
          .pipe(
            Effect.mapError(
              (cause) => new MemoryServiceError({ message: "Failed to list memory files.", cause }),
            ),
          );
        return changedNowToFileList(report);
      });

    // listSessions maps `pallium sessions list`. Sessions are home-DB scoped (not repo-epoch
    // scoped), so we cache by command+args under a constant epoch with the TTL as the only backstop.
    const listSessions = (input?: MemoryListSessionsInput) =>
      Effect.gen(function* () {
        const palliumStatus = yield* pallium.status;
        if (!palliumStatus.available) {
          return emptySessionList(false);
        }
        const now = new Date();
        const limit = input?.limit;
        const argsKey = limit !== undefined ? `limit=${limit}` : "";
        const cached = yield* readCachedResult({
          schema: MemorySessionList,
          command: SESSIONS_CACHE_COMMAND,
          args: argsKey,
          projectId: GLOBAL_PROJECT_ID,
          indexEpoch: HOME_DB_EPOCH,
          now,
        });
        if (Option.isSome(cached)) {
          return cached.value;
        }
        const sessions = yield* pallium
          .sessionsList(limit !== undefined ? { limit } : undefined)
          .pipe(
            Effect.mapError(
              (cause) =>
                new MemoryServiceError({ message: "Failed to list memory sessions.", cause }),
            ),
          );
        const result = sessionsToSessionList(sessions);
        yield* writeCachedResult({
          schema: MemorySessionList,
          command: SESSIONS_CACHE_COMMAND,
          args: argsKey,
          projectId: GLOBAL_PROJECT_ID,
          indexEpoch: HOME_DB_EPOCH,
          value: result,
          now,
          ttlMs: SESSIONS_CACHE_TTL_MS,
        });
        return result;
      });

    // listDecisions maps `pallium decisions <query> <repo>`. GAP A: the query is required and Pallium
    // caps results at ~10; there is no "list all" mode. Cached by command+args (query + project)
    // under a constant epoch with the TTL as the only backstop.
    const listDecisions = (input: MemoryListDecisionsInput) =>
      Effect.gen(function* () {
        const palliumStatus = yield* pallium.status;
        if (!palliumStatus.available) {
          return emptyDecisionList(false);
        }
        const projectId = input.projectId;
        const repoPath = yield* projectId === undefined
          ? Effect.succeed(Option.none<string>())
          : resolveRepoPath(projectId);
        // A project was named but could not be resolved to a repo: nothing to search.
        if (projectId !== undefined && Option.isNone(repoPath)) {
          return emptyDecisionList(true);
        }
        const now = new Date();
        const cacheProjectId = projectId ?? GLOBAL_PROJECT_ID;
        const argsKey = `query=${input.query}`;
        const cached = yield* readCachedResult({
          schema: MemoryDecisionList,
          command: DECISIONS_CACHE_COMMAND,
          args: argsKey,
          projectId: cacheProjectId,
          indexEpoch: HOME_DB_EPOCH,
          now,
        });
        if (Option.isSome(cached)) {
          return cached.value;
        }
        const decisions = yield* pallium
          .decisions({
            query: input.query,
            ...(Option.isSome(repoPath) ? { cwd: repoPath.value } : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new MemoryServiceError({ message: "Failed to list memory decisions.", cause }),
            ),
          );
        const result = decisionsToDecisionList(decisions);
        yield* writeCachedResult({
          schema: MemoryDecisionList,
          command: DECISIONS_CACHE_COMMAND,
          args: argsKey,
          projectId: cacheProjectId,
          indexEpoch: HOME_DB_EPOCH,
          value: result,
          now,
          ttlMs: DECISIONS_CACHE_TTL_MS,
        });
        return result;
      });

    // search maps `pallium sessions search <query>`. Pure LEXICAL (default, non-hybrid) search over
    // the home-level session DB, so it works regardless of embedding setup. Home-DB scoped (not
    // repo-epoch scoped), so cached by command+args under a constant epoch with the TTL as the only
    // backstop. An empty/whitespace query short-circuits to an empty list (Pallium rejects an empty
    // query; per strict-optional we never reach the binary).
    const search = (input: MemorySearchInput) =>
      Effect.gen(function* () {
        const palliumStatus = yield* pallium.status;
        if (!palliumStatus.available) {
          return emptySearchResultList(false);
        }
        const query = input.query.trim();
        if (query.length === 0) {
          return emptySearchResultList(true);
        }
        const now = new Date();
        const limit = input.limit;
        const argsKey = limit !== undefined ? `query=${query}&limit=${limit}` : `query=${query}`;
        const cached = yield* readCachedResult({
          schema: MemorySearchResultList,
          command: SEARCH_CACHE_COMMAND,
          args: argsKey,
          projectId: GLOBAL_PROJECT_ID,
          indexEpoch: HOME_DB_EPOCH,
          now,
        });
        if (Option.isSome(cached)) {
          return cached.value;
        }
        const results = yield* pallium
          .sessionsSearch({ query, ...(limit !== undefined ? { limit } : {}) })
          .pipe(
            Effect.mapError(
              (cause) =>
                new MemoryServiceError({ message: "Failed to search memory sessions.", cause }),
            ),
          );
        const result = searchToResultList(results);
        yield* writeCachedResult({
          schema: MemorySearchResultList,
          command: SEARCH_CACHE_COMMAND,
          args: argsKey,
          projectId: GLOBAL_PROJECT_ID,
          indexEpoch: HOME_DB_EPOCH,
          value: result,
          now,
          ttlMs: SEARCH_CACHE_TTL_MS,
        });
        return result;
      });

    return {
      status,
      overview,
      listFiles,
      listSessions,
      listDecisions,
      search,
    } satisfies MemoryServiceShape;
  }),
);
