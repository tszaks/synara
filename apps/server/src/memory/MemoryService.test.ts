// FILE: MemoryService.test.ts
// Purpose: Verifies the first user-visible Memory read path — strict-optional absence (status =>
//          available:false and overview => a valid empty overview, no throw), the doctor ->
//          MemoryOverview mapping, and that two overview calls in one index epoch invoke the
//          underlying Pallium doctor runner only once (cache hit).
// Layer: Memory service test
// Depends on: MemoryServiceLive with injected fakes for PalliumService, PalliumCommandCache, and
//             ProjectionSnapshotQuery, plus ServerSettingsService.layerTest.

import { assert, it } from "@effect/vitest";
import {
  type PalliumChangedNowResult,
  type PalliumDecisionList,
  type PalliumDoctorResult,
  type PalliumEmbedResult,
  type PalliumIndexResult,
  type PalliumSessionList,
  type PalliumSessionSearchList,
  type PalliumSessionSemanticList,
  type PalliumStatus,
  ProjectId,
  type MemoryOverview,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MemoryServiceError } from "./Errors.ts";
import {
  type GetPalliumCommandCacheInput,
  PalliumCommandCacheRepository,
  type PalliumCommandCacheEntry,
  type PalliumCommandCacheRepositoryShape,
  type PutPalliumCommandCacheInput,
} from "../persistence/Services/PalliumCommandCache.ts";
import { PalliumService, type PalliumServiceShape } from "../pallium/Services/PalliumService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MemoryServiceLive } from "./Layers/MemoryService.ts";
import { MemoryService } from "./Services/MemoryService.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project:test");
const REPO_PATH = "/repo";

const unavailableStatus: PalliumStatus = {
  available: false,
  capabilities: { indexed: false, embeddings: false, openaiKeyAvailable: false },
  checkedAt: "2026-06-24T00:00:00.000Z",
  reason: "pallium not found on PATH",
};

const availableStatus: PalliumStatus = {
  available: true,
  binaryPath: "pallium",
  version: "1.2.3",
  capabilities: { indexed: true, embeddings: true, openaiKeyAvailable: true },
  checkedAt: "2026-06-24T00:00:00.000Z",
};

const doctorFixture: PalliumDoctorResult = {
  repo_root: REPO_PATH,
  repo_db_path: "/repo/.pallium/pallium.sqlite",
  repo_db_exists: true,
  index_status: "indexed",
  indexed_branch: "main",
  last_indexed_commit: "abc123",
  indexed_at: "2026-06-23T12:00:00.000Z",
  current_branch: "main",
  current_commit: "abc123",
  working_tree_dirty: true,
  working_tree_file_count: 7,
  session_db_path: "/home/.pallium/sessions.sqlite",
  session_db_exists: true,
  session_stats: {
    sessions: 10,
    events: 20,
    messages: 30,
    chunks: 40,
    embeddings: 50,
    models: [{ provider: "ollama", model: "nomic-embed-text", dim: 768, count: 50 }],
  },
  embedding_model: "nomic-embed-text",
  embedding_backlog: 3,
  openai_key_available: true,
};

// The doctor report AFTER a re-index: the epoch (last_indexed_commit) has advanced and the counts
// moved, so a fresh overview must reflect these rather than the pre-index cached row.
const doctorAfterIndexFixture: PalliumDoctorResult = {
  ...doctorFixture,
  last_indexed_commit: "def456",
  indexed_at: "2026-06-24T08:00:00.000Z",
  current_commit: "def456",
  working_tree_dirty: false,
  working_tree_file_count: 0,
  session_stats: { ...doctorFixture.session_stats, sessions: 11 },
};

const changedNowFixture: PalliumChangedNowResult = {
  summary: "2 files changed",
  index_status: "indexed",
  files: [
    {
      path: "src/app.ts",
      working_tree_status: "modified",
      risk_level: "high",
      suggested_tests: ["src/app.test.ts"],
      blast_radius: ["src/router.ts", "src/server.ts"],
    },
    {
      path: "README.md",
      working_tree_status: "added",
      risk_level: "low",
      suggested_tests: null,
      blast_radius: null,
    },
  ],
};

const sessionsFixture: PalliumSessionList = [
  {
    id: "sess-1",
    title: "Fix the router",
    cwd: "/repo",
    source: "codex",
    model_provider: "openai",
    model: "gpt-5",
    git_branch: "feat/router",
    created_at: "2026-06-20T10:00:00.000Z",
    updated_at: "2026-06-20T11:00:00.000Z",
    tokens_used: 1234,
    status: "completed",
  },
  { id: "sess-2" },
];

const decisionsFixture: PalliumDecisionList = [
  {
    source_type: "commit",
    source_ref: "abc1234567",
    title: "Adopt epoch-keyed cache",
    body: "We key the cache on index epoch so a re-index misses old rows for free.",
    committed_at: "2026-06-21T09:00:00.000Z",
  },
];

// A representative `pallium sessions search <query>` payload. SearchResult embeds Session, so the
// session fields are flattened at the top level alongside rank/score/signals.
const searchFixture: PalliumSessionSearchList = [
  {
    id: "sess-1",
    title: "Fix the router",
    cwd: "/repo",
    source: "codex",
    model_provider: "openai",
    model: "gpt-5",
    git_branch: "feat/router",
    created_at: "2026-06-20T10:00:00.000Z",
    updated_at: "2026-06-20T11:00:00.000Z",
    status: "completed",
    score: 12,
    signals: ["title", "first_user_message"],
  },
  // A minimal hit: only an id, no score/signals.
  { id: "sess-2" },
];

// A representative `pallium index <repo>` payload (index.Result). `indexed_at` changes every run.
const indexFixture: PalliumIndexResult = {
  repo_root: REPO_PATH,
  branch: "main",
  commit_count: 120,
  file_count: 340,
  cochange_edge_count: 56,
  indexed_at: "2026-06-24T08:00:00.000Z",
};

// A fake PalliumService whose runners increment counters so the test can assert the binary was (or
// was not) re-invoked. `status` is constant per fixture.
interface FakePalliumOptions {
  readonly status: PalliumStatus;
  readonly doctor?: PalliumDoctorResult;
  readonly doctorCallsRef: Ref.Ref<number>;
  readonly changedNow?: PalliumChangedNowResult;
  readonly changedNowCallsRef?: Ref.Ref<number>;
  readonly sessions?: PalliumSessionList;
  readonly sessionsCallsRef?: Ref.Ref<number>;
  readonly decisions?: PalliumDecisionList;
  readonly decisionsCallsRef?: Ref.Ref<number>;
  readonly search?: PalliumSessionSearchList;
  readonly searchCallsRef?: Ref.Ref<number>;
  readonly index?: PalliumIndexResult;
  readonly indexCallsRef?: Ref.Ref<number>;
  // When set, doctor returns this AFTER the first call (simulates the epoch advancing post-index).
  readonly doctorAfterIndex?: PalliumDoctorResult;
  readonly semantic?: PalliumSessionSemanticList;
  readonly semanticCallsRef?: Ref.Ref<number>;
  readonly embed?: PalliumEmbedResult;
  readonly embedCallsRef?: Ref.Ref<number>;
}

const tick = (ref: Ref.Ref<number> | undefined) =>
  ref ? Ref.update(ref, (count) => count + 1) : Effect.void;

const makeFakePalliumLayer = (options: FakePalliumOptions) =>
  Layer.succeed(PalliumService, {
    status: Effect.succeed(options.status),
    version: Effect.die("version not used in MemoryService tests"),
    doctor: () =>
      Ref.updateAndGet(options.doctorCallsRef, (count) => count + 1).pipe(
        Effect.flatMap((calls) => {
          // After the first call, return the post-index doctor fixture when provided (simulates the
          // epoch advancing after a re-index); otherwise return the steady-state doctor fixture.
          const fixture =
            calls > 1 && options.doctorAfterIndex ? options.doctorAfterIndex : options.doctor;
          return fixture ? Effect.succeed(fixture) : Effect.die("doctor fixture missing");
        }),
      ),
    changedNow: () =>
      tick(options.changedNowCallsRef).pipe(
        Effect.flatMap(() =>
          options.changedNow
            ? Effect.succeed(options.changedNow)
            : Effect.die("changedNow fixture missing"),
        ),
      ),
    sessionsList: () =>
      tick(options.sessionsCallsRef).pipe(
        Effect.flatMap(() =>
          options.sessions !== undefined
            ? Effect.succeed(options.sessions)
            : Effect.die("sessions fixture missing"),
        ),
      ),
    decisions: () =>
      tick(options.decisionsCallsRef).pipe(
        Effect.flatMap(() =>
          options.decisions !== undefined
            ? Effect.succeed(options.decisions)
            : Effect.die("decisions fixture missing"),
        ),
      ),
    sessionsSearch: () =>
      tick(options.searchCallsRef).pipe(
        Effect.flatMap(() =>
          options.search !== undefined
            ? Effect.succeed(options.search)
            : Effect.die("search fixture missing"),
        ),
      ),
    sessionsSemantic: () =>
      tick(options.semanticCallsRef).pipe(
        Effect.flatMap(() =>
          options.semantic !== undefined
            ? Effect.succeed(options.semantic)
            : Effect.die("semantic fixture missing"),
        ),
      ),
    sessionsEmbed: () =>
      tick(options.embedCallsRef).pipe(
        Effect.flatMap(() =>
          options.embed !== undefined
            ? Effect.succeed(options.embed)
            : Effect.die("embed fixture missing"),
        ),
      ),
    index: () =>
      tick(options.indexCallsRef).pipe(
        Effect.flatMap(() =>
          options.index !== undefined
            ? Effect.succeed(options.index)
            : Effect.die("index fixture missing"),
        ),
      ),
  } satisfies PalliumServiceShape);

// An in-memory cache fake mirroring the real repository's epoch + TTL semantics. Keyed on
// command+args+projectId+indexEpoch; a row only hits when it has not expired relative to `now`.
const makeFakeCacheLayer = (options?: {
  readonly invalidateStaleEpochsCallsRef?: Ref.Ref<number>;
}) =>
  Effect.gen(function* () {
    const store = yield* Ref.make(new Map<string, PalliumCommandCacheEntry>());
    const keyOf = (input: {
      readonly command: string;
      readonly args: string;
      readonly projectId: ProjectId;
      readonly indexEpoch: string;
    }) => `${input.command} ${input.args} ${input.projectId} ${input.indexEpoch}`;

    const get: PalliumCommandCacheRepositoryShape["get"] = (input: GetPalliumCommandCacheInput) =>
      Ref.get(store).pipe(
        Effect.map((map) => {
          const entry = map.get(keyOf(input));
          if (!entry || entry.expiresAt <= input.now) {
            return Option.none<PalliumCommandCacheEntry>();
          }
          return Option.some(entry);
        }),
      );

    const put: PalliumCommandCacheRepositoryShape["put"] = (input: PutPalliumCommandCacheInput) =>
      Ref.update(store, (map) => {
        const next = new Map(map);
        next.set(keyOf(input), input);
        return next;
      });

    const invalidateStaleEpochs: PalliumCommandCacheRepositoryShape["invalidateStaleEpochs"] = (
      input,
    ) =>
      tick(options?.invalidateStaleEpochsCallsRef).pipe(
        Effect.flatMap(() =>
          // Mirror the real repo: drop every cached row for this project whose epoch differs from
          // the current one. The fake keeps full rows so the test can observe the post-index miss.
          Ref.update(store, (map) => {
            const next = new Map<string, PalliumCommandCacheEntry>();
            for (const [key, entry] of map) {
              const stale =
                entry.projectId === input.projectId && entry.indexEpoch !== input.currentIndexEpoch;
              if (!stale) {
                next.set(key, entry);
              }
            }
            return next;
          }),
        ),
      );
    const sweepExpired: PalliumCommandCacheRepositoryShape["sweepExpired"] = () => Effect.void;

    return {
      get,
      put,
      invalidateStaleEpochs,
      sweepExpired,
    } satisfies PalliumCommandCacheRepositoryShape;
  }).pipe(Layer.effect(PalliumCommandCacheRepository));

// A minimal ProjectionSnapshotQuery fake: only getProjectShellById is exercised by MemoryService.
// The remaining methods die loudly if ever called so an accidental dependency surfaces in tests.
const makeFakeProjectionsLayer = (input: { readonly resolveRepo: boolean }) =>
  Layer.succeed(
    ProjectionSnapshotQuery,
    new Proxy(
      {
        getProjectShellById: () =>
          Effect.succeed(
            input.resolveRepo ? Option.some({ workspaceRoot: REPO_PATH } as never) : Option.none(),
          ),
      },
      {
        get(target, prop, receiver) {
          if (prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return () => Effect.die(`ProjectionSnapshotQuery.${String(prop)} not used in test`);
        },
      },
    ) as never,
  );

const makeMemoryLayer = (input: {
  readonly status: PalliumStatus;
  readonly doctor?: PalliumDoctorResult;
  readonly doctorCallsRef: Ref.Ref<number>;
  readonly resolveRepo?: boolean;
  readonly changedNow?: PalliumChangedNowResult;
  readonly changedNowCallsRef?: Ref.Ref<number>;
  readonly sessions?: PalliumSessionList;
  readonly sessionsCallsRef?: Ref.Ref<number>;
  readonly decisions?: PalliumDecisionList;
  readonly decisionsCallsRef?: Ref.Ref<number>;
  readonly search?: PalliumSessionSearchList;
  readonly searchCallsRef?: Ref.Ref<number>;
  readonly semantic?: PalliumSessionSemanticList;
  readonly semanticCallsRef?: Ref.Ref<number>;
  readonly embed?: PalliumEmbedResult;
  readonly embedCallsRef?: Ref.Ref<number>;
  readonly index?: PalliumIndexResult;
  readonly indexCallsRef?: Ref.Ref<number>;
  readonly doctorAfterIndex?: PalliumDoctorResult;
  readonly invalidateStaleEpochsCallsRef?: Ref.Ref<number>;
}) =>
  MemoryServiceLive.pipe(
    Layer.provide(makeFakePalliumLayer(input)),
    Layer.provide(
      makeFakeCacheLayer(
        input.invalidateStaleEpochsCallsRef !== undefined
          ? { invalidateStaleEpochsCallsRef: input.invalidateStaleEpochsCallsRef }
          : undefined,
      ),
    ),
    Layer.provide(makeFakeProjectionsLayer({ resolveRepo: input.resolveRepo ?? true })),
    Layer.provide(ServerSettingsService.layerTest()),
  );

it.effect("status flows Pallium absence through to available:false", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const status = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.status;
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef }),
    );
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.capabilities.indexed, false);
    assert.strictEqual(status.reason, "pallium not found on PATH");
  }),
);

it.effect("overview returns a valid empty overview (no throw) when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.overview({ projectId: PROJECT_ID });
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef }),
    );
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.indexed, false);
    assert.strictEqual(result.indexStatus, "missing");
    assert.strictEqual(result.counts.sessions, 0);
    assert.strictEqual(result.embeddingModels.length, 0);
    // Unavailable means we never even reach the doctor probe.
    assert.strictEqual(yield* Ref.get(doctorCallsRef), 0);
  }),
);

it.effect("overview maps a doctor fixture into MemoryOverview", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result: MemoryOverview = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.overview({ projectId: PROJECT_ID });
      }),
      makeMemoryLayer({ status: availableStatus, doctor: doctorFixture, doctorCallsRef }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.indexed, true);
    assert.strictEqual(result.indexStatus, "indexed");
    assert.strictEqual(result.lastIndexedCommit, "abc123");
    assert.strictEqual(result.lastIndexedAt, "2026-06-23T12:00:00.000Z");
    assert.strictEqual(result.workingTreeDirty, true);
    assert.strictEqual(result.counts.sessions, 10);
    assert.strictEqual(result.counts.messages, 30);
    assert.strictEqual(result.counts.embeddings, 50);
    assert.strictEqual(result.counts.workingTreeFiles, 7);
    assert.strictEqual(result.embeddingBacklog, 3);
    assert.strictEqual(result.embeddingModels.length, 1);
    assert.strictEqual(result.embeddingModels[0]?.model, "nomic-embed-text");
    assert.strictEqual(result.embeddingModels[0]?.count, 50);
  }),
);

it.effect("two overview calls in one epoch invoke the doctor runner once (cache hit)", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        const first = yield* memory.overview({ projectId: PROJECT_ID });
        const second = yield* memory.overview({ projectId: PROJECT_ID });
        assert.deepStrictEqual(first, second);
      }),
      makeMemoryLayer({ status: availableStatus, doctor: doctorFixture, doctorCallsRef }),
    );
    // The first call probes doctor to learn the epoch + fill the cache; the second is served from
    // the cache under the remembered epoch and must NOT spawn the binary again.
    assert.strictEqual(yield* Ref.get(doctorCallsRef), 1);
  }),
);

// --- listFiles -----------------------------------------------------------------------------------

it.effect("listFiles returns an empty list (no throw) when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const changedNowCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listFiles({ projectId: PROJECT_ID });
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef, changedNowCallsRef }),
    );
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.files.length, 0);
    // Unavailable means we never reach the changed-now probe.
    assert.strictEqual(yield* Ref.get(changedNowCallsRef), 0);
  }),
);

it.effect("listFiles maps a changed-now fixture into MemoryFileList", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listFiles({ projectId: PROJECT_ID });
      }),
      makeMemoryLayer({
        status: availableStatus,
        doctorCallsRef,
        changedNow: changedNowFixture,
      }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.files.length, 2);
    assert.strictEqual(result.files[0]?.path, "src/app.ts");
    assert.strictEqual(result.files[0]?.workingTreeStatus, "modified");
    assert.strictEqual(result.files[0]?.riskLevel, "high");
    assert.deepStrictEqual([...(result.files[0]?.suggestedTests ?? [])], ["src/app.test.ts"]);
    assert.deepStrictEqual(
      [...(result.files[0]?.blastRadius ?? [])],
      ["src/router.ts", "src/server.ts"],
    );
    // null suggested_tests / blast_radius fold into empty arrays.
    assert.strictEqual(result.files[1]?.path, "README.md");
    assert.strictEqual(result.files[1]?.suggestedTests.length, 0);
    assert.strictEqual(result.files[1]?.blastRadius.length, 0);
  }),
);

// --- listSessions --------------------------------------------------------------------------------

it.effect("listSessions returns an empty list (no throw) when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const sessionsCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listSessions();
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef, sessionsCallsRef }),
    );
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.sessions.length, 0);
    assert.strictEqual(yield* Ref.get(sessionsCallsRef), 0);
  }),
);

it.effect("listSessions maps a sessions fixture into MemorySessionList", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listSessions({ limit: 20 });
      }),
      makeMemoryLayer({ status: availableStatus, doctorCallsRef, sessions: sessionsFixture }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.sessions.length, 2);
    assert.strictEqual(result.sessions[0]?.id, "sess-1");
    assert.strictEqual(result.sessions[0]?.title, "Fix the router");
    assert.strictEqual(result.sessions[0]?.modelProvider, "openai");
    assert.strictEqual(result.sessions[0]?.gitBranch, "feat/router");
    assert.strictEqual(result.sessions[0]?.updatedAt, "2026-06-20T11:00:00.000Z");
    // A minimal session decodes with only its id.
    assert.strictEqual(result.sessions[1]?.id, "sess-2");
    assert.strictEqual(result.sessions[1]?.title, undefined);
  }),
);

it.effect("two listSessions calls with the same args hit the cache (one spawn)", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const sessionsCallsRef = yield* Ref.make(0);
    yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        const first = yield* memory.listSessions({ limit: 20 });
        const second = yield* memory.listSessions({ limit: 20 });
        assert.deepStrictEqual(first, second);
      }),
      makeMemoryLayer({
        status: availableStatus,
        doctorCallsRef,
        sessions: sessionsFixture,
        sessionsCallsRef,
      }),
    );
    assert.strictEqual(yield* Ref.get(sessionsCallsRef), 1);
  }),
);

// --- listDecisions -------------------------------------------------------------------------------

it.effect("listDecisions returns an empty list (no throw) when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const decisionsCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listDecisions({ query: "cache", projectId: PROJECT_ID });
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef, decisionsCallsRef }),
    );
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.decisions.length, 0);
    assert.strictEqual(yield* Ref.get(decisionsCallsRef), 0);
  }),
);

it.effect("listDecisions maps a decisions fixture into MemoryDecisionList", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listDecisions({ query: "cache", projectId: PROJECT_ID });
      }),
      makeMemoryLayer({
        status: availableStatus,
        doctorCallsRef,
        decisions: decisionsFixture,
      }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.decisions.length, 1);
    assert.strictEqual(result.decisions[0]?.title, "Adopt epoch-keyed cache");
    assert.strictEqual(result.decisions[0]?.sourceRef, "abc1234567");
    assert.strictEqual(result.decisions[0]?.committedAt, "2026-06-21T09:00:00.000Z");
  }),
);

it.effect("listDecisions returns an empty list when the named project cannot be resolved", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const decisionsCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.listDecisions({ query: "cache", projectId: PROJECT_ID });
      }),
      makeMemoryLayer({
        status: availableStatus,
        doctorCallsRef,
        decisions: decisionsFixture,
        decisionsCallsRef,
        resolveRepo: false,
      }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.decisions.length, 0);
    // We never spawn the binary for an unresolved project.
    assert.strictEqual(yield* Ref.get(decisionsCallsRef), 0);
  }),
);

// --- search (lexical session search) -------------------------------------------------------------

it.effect("search returns an empty list (no throw) when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const searchCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.search({ query: "router" });
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef, searchCallsRef }),
    );
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.results.length, 0);
    // Unavailable means we never reach the search runner.
    assert.strictEqual(yield* Ref.get(searchCallsRef), 0);
  }),
);

it.effect("search maps a sessions-search fixture into MemorySearchResultList", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.search({ query: "router", limit: 10 });
      }),
      makeMemoryLayer({ status: availableStatus, doctorCallsRef, search: searchFixture }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.results[0]?.id, "sess-1");
    assert.strictEqual(result.results[0]?.title, "Fix the router");
    assert.strictEqual(result.results[0]?.modelProvider, "openai");
    assert.strictEqual(result.results[0]?.gitBranch, "feat/router");
    assert.strictEqual(result.results[0]?.score, 12);
    assert.deepStrictEqual(
      [...(result.results[0]?.signals ?? [])],
      ["title", "first_user_message"],
    );
    // A minimal hit decodes with only its id; missing score is dropped, signals fold to empty.
    assert.strictEqual(result.results[1]?.id, "sess-2");
    assert.strictEqual(result.results[1]?.score, undefined);
    assert.strictEqual(result.results[1]?.signals.length, 0);
  }),
);

it.effect("search handles an empty query gracefully without spawning the binary", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const searchCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.search({ query: "   " });
      }),
      makeMemoryLayer({
        status: availableStatus,
        doctorCallsRef,
        search: searchFixture,
        searchCallsRef,
      }),
    );
    // Available, but an empty/whitespace query short-circuits to an empty list (Pallium rejects an
    // empty query), so the runner is never reached.
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(yield* Ref.get(searchCallsRef), 0);
  }),
);

// --- searchSemantic (vector session search) ------------------------------------------------------

// available, but embeddings capability is OFF (no embedding space). Semantic search must degrade to
// an empty-but-valid list so the UI can fall back to lexical, NOT throw.
const availableNoEmbeddingsStatus: PalliumStatus = {
  available: true,
  binaryPath: "pallium",
  version: "1.2.3",
  capabilities: { indexed: true, embeddings: false, openaiKeyAvailable: false },
  checkedAt: "2026-06-24T00:00:00.000Z",
};

// A representative `pallium sessions semantic <query>` payload. SemanticResult embeds Session, so the
// session fields are flattened, alongside a float `similarity` (NOT an integer match score).
const semanticFixture: PalliumSessionSemanticList = [
  {
    id: "sess-1",
    title: "Fix the router",
    cwd: "/repo",
    model_provider: "openai",
    git_branch: "feat/router",
    similarity: 0.91,
  },
  { id: "sess-2" },
];

it.effect("searchSemantic returns empty (no throw) when the embeddings capability is false", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const semanticCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.searchSemantic({ query: "router" });
      }),
      makeMemoryLayer({
        status: availableNoEmbeddingsStatus,
        doctorCallsRef,
        semantic: semanticFixture,
        semanticCallsRef,
      }),
    );
    // Available (Pallium is present) but embeddings are off, so we never reach the semantic runner.
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(yield* Ref.get(semanticCallsRef), 0);
  }),
);

it.effect("searchSemantic maps a semantic fixture into MemorySearchResultList", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.searchSemantic({ query: "router", limit: 10 });
      }),
      makeMemoryLayer({ status: availableStatus, doctorCallsRef, semantic: semanticFixture }),
    );
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.results[0]?.id, "sess-1");
    assert.strictEqual(result.results[0]?.title, "Fix the router");
    assert.strictEqual(result.results[0]?.modelProvider, "openai");
    assert.strictEqual(result.results[0]?.gitBranch, "feat/router");
    // The float similarity is NOT mapped into the integer `score`; signals fold to empty.
    assert.strictEqual(result.results[0]?.score, undefined);
    assert.strictEqual(result.results[0]?.signals.length, 0);
    assert.strictEqual(result.results[1]?.id, "sess-2");
  }),
);

it.effect("searchSemantic returns empty (no throw) when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const semanticCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.searchSemantic({ query: "router" });
      }),
      makeMemoryLayer({ status: unavailableStatus, doctorCallsRef, semanticCallsRef }),
    );
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(yield* Ref.get(semanticCallsRef), 0);
  }),
);

// --- embedSessions (mutate) ----------------------------------------------------------------------

const embedFixture: PalliumEmbedResult = { embedded: 7, model: "bge-m3" };

it.effect("embedSessions fails fast with a typed error when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const embedCallsRef = yield* Ref.make(0);
    const exit = yield* Effect.exit(
      Effect.provide(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          return yield* memory.embedSessions({});
        }),
        makeMemoryLayer({
          status: unavailableStatus,
          doctorCallsRef,
          embed: embedFixture,
          embedCallsRef,
        }),
      ),
    );
    // MUTATING: unavailable must FAIL (not fold to an empty result), and never reach the runner.
    assert.isTrue(Exit.isFailure(exit));
    const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause);
    assert.instanceOf(error, MemoryServiceError);
    assert.strictEqual(yield* Ref.get(embedCallsRef), 0);
  }),
);

it.effect("embedSessions maps the embed result when Pallium is available", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.embedSessions({});
      }),
      makeMemoryLayer({ status: availableStatus, doctorCallsRef, embed: embedFixture }),
    );
    assert.strictEqual(result.embedded, 7);
    assert.strictEqual(result.model, "bge-m3");
  }),
);

it.effect("index fails fast with a typed error when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const indexCallsRef = yield* Ref.make(0);
    const exit = yield* Effect.exit(
      Effect.provide(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          return yield* memory.index({ projectId: PROJECT_ID });
        }),
        makeMemoryLayer({
          status: unavailableStatus,
          doctorCallsRef,
          index: indexFixture,
          indexCallsRef,
        }),
      ),
    );
    // MUTATING: unavailable must FAIL (not fold to an empty result), and never reach the runner.
    assert.isTrue(Exit.isFailure(exit));
    const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause);
    assert.instanceOf(error, MemoryServiceError);
    assert.strictEqual(yield* Ref.get(indexCallsRef), 0);
  }),
);

it.effect("index maps the index result when Pallium is available", () =>
  Effect.gen(function* () {
    const doctorCallsRef = yield* Ref.make(0);
    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.index({ projectId: PROJECT_ID });
      }),
      makeMemoryLayer({
        status: availableStatus,
        doctor: doctorFixture,
        doctorCallsRef,
        index: indexFixture,
      }),
    );
    assert.strictEqual(result.repoRoot, REPO_PATH);
    assert.strictEqual(result.branch, "main");
    assert.strictEqual(result.commitCount, 120);
    assert.strictEqual(result.fileCount, 340);
    assert.strictEqual(result.cochangeEdgeCount, 56);
  }),
);

it.effect(
  "index invalidates the durable cache AND the in-process memo so the next overview is fresh",
  () =>
    Effect.gen(function* () {
      const doctorCallsRef = yield* Ref.make(0);
      const indexCallsRef = yield* Ref.make(0);
      const invalidateStaleEpochsCallsRef = yield* Ref.make(0);
      const layer = makeMemoryLayer({
        status: availableStatus,
        // doctor returns the pre-index fixture first, then the post-index fixture on every later
        // call (simulating the epoch + counts advancing after the re-index).
        doctor: doctorFixture,
        doctorAfterIndex: doctorAfterIndexFixture,
        doctorCallsRef,
        index: indexFixture,
        indexCallsRef,
        invalidateStaleEpochsCallsRef,
      });

      yield* Effect.provide(
        Effect.gen(function* () {
          const memory = yield* MemoryService;

          // 1) Prime: first overview spawns doctor once (epoch "abc123") and caches that row.
          const first = yield* memory.overview({ projectId: PROJECT_ID });
          assert.strictEqual(first.counts.sessions, 10);
          assert.strictEqual(yield* Ref.get(doctorCallsRef), 1);

          // 2) Re-index: spawns index, then probes doctor again to learn the new epoch (call 2),
          //    invalidates the durable cache, and clears the in-process epoch memo.
          yield* memory.index({ projectId: PROJECT_ID });
          assert.strictEqual(yield* Ref.get(indexCallsRef), 1);
          assert.strictEqual(yield* Ref.get(invalidateStaleEpochsCallsRef), 1);

          // 3) Next overview must NOT short-circuit on the stale memo: with the memo cleared and the
          //    old epoch row invalidated, it re-probes doctor (call 4) and reflects the fresh counts
          //    immediately — no TTL wait.
          const after = yield* memory.overview({ projectId: PROJECT_ID });
          assert.strictEqual(after.counts.sessions, 11);
          assert.isFalse(after.workingTreeDirty);
          assert.strictEqual(after.lastIndexedCommit, "def456");
          assert.isTrue((yield* Ref.get(doctorCallsRef)) >= 3);
        }),
        layer,
      );
    }),
);
