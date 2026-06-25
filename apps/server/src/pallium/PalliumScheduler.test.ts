// FILE: PalliumScheduler.test.ts
// Purpose: Verifies the automatic background indexing scheduler — minute-clamped idle sleep, a
//          diff-completed wakeup triggering a pass, the DB lease preventing a double-run, and a
//          cheap no-op when Pallium is unavailable.
// Layer: Pallium scheduler test
// Depends on: makePalliumSchedulerLive with fake PalliumService / MemoryService /
//             ProjectionSnapshotQuery / OrchestrationEngineService / AutomationRepository layers.

import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type MemoryIndexResult,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type PalliumDoctorResult,
  type PalliumEmbedResult,
  type PalliumStatus,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import { MemoryService } from "../memory/Services/MemoryService.ts";
import type { MemoryServiceShape } from "../memory/Services/MemoryService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../persistence/Services/AutomationRepository.ts";
import type { AutomationRepositoryShape } from "../persistence/Services/AutomationRepository.ts";
import { makePalliumSchedulerLive } from "./Layers/PalliumScheduler.ts";
import { PalliumScheduler } from "./Services/PalliumScheduler.ts";
import { PalliumService } from "./Services/PalliumService.ts";

function unusedEffect(): Effect.Effect<never> {
  return Effect.die("unused scheduler test method");
}

const availableStatus: PalliumStatus = {
  available: true,
  capabilities: { indexed: true, embeddings: false, openaiKeyAvailable: false },
  checkedAt: "2026-06-24T00:00:00.000Z",
};

const unavailableStatus: PalliumStatus = {
  available: false,
  capabilities: { indexed: false, embeddings: false, openaiKeyAvailable: false },
  checkedAt: "2026-06-24T00:00:00.000Z",
  reason: "pallium not found",
};

// A doctor report whose committed HEAD has moved past the last indexed commit → stale → triggers a
// refresh.
const staleDoctor: PalliumDoctorResult = {
  repo_root: "/repo",
  repo_db_path: "/repo/.pallium/pallium.sqlite",
  repo_db_exists: true,
  index_status: "indexed",
  last_indexed_commit: "aaaaaaa",
  current_commit: "bbbbbbb",
  working_tree_dirty: false,
  working_tree_file_count: 0,
  session_db_path: "/home/.pallium/sessions.sqlite",
  session_db_exists: true,
  session_stats: { sessions: 0, events: 0, messages: 0, chunks: 0, embeddings: 0 },
  embedding_model: "text-embedding-3-small",
  embedding_backlog: 0,
  openai_key_available: false,
};

const emptyEmbed: PalliumEmbedResult = { embedded: 0 };
const emptyIndex: MemoryIndexResult = {
  repoRoot: "/repo",
  commitCount: 0,
  fileCount: 0,
  cochangeEdgeCount: 0,
};

const shellSnapshotWithProject = (projectId: ProjectId): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [
    {
      id: projectId,
      title: "Repo",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    },
  ],
  threads: [],
  updatedAt: "2026-06-24T00:00:00.000Z",
});

interface Counters {
  indexCalls: number;
  embedCalls: number;
  leaseCalls: number;
  doctorCalls: number;
}

it.effect("clamps the idle sleep to the minute range (never sub-second)", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const counters: Counters = { indexCalls: 0, embedCalls: 0, leaseCalls: 0, doctorCalls: 0 };
    // intervalMs is forced to a sub-second value; the scheduler must clamp it up to the 60s floor,
    // so no second pass may fire before a full minute elapses.
    const fakeLayer = makePalliumSchedulerLive({ intervalMs: 10 }).pipe(
      Layer.provide(buildFakeContext({ events, counters })),
    );

    yield* Effect.gen(function* () {
      const scheduler = yield* PalliumScheduler;
      yield* scheduler.start();
      yield* TestClock.adjust(Duration.zero);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(counters.indexCalls, 1, "first pass runs immediately");

      // Advancing well under a minute must NOT fire a second pass: the interval was clamped to 60s.
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(counters.indexCalls, 1, "no sub-minute second pass");

      // Crossing the 60s floor fires the next pass.
      yield* TestClock.adjust(Duration.seconds(31));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(counters.indexCalls, 2, "second pass after the minute floor");
    }).pipe(Effect.provide(fakeLayer), Effect.scoped);
  }),
);

it.effect("wakes a long sleep when a diff-completed turn event arrives", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const counters = { indexCalls: 0, embedCalls: 0, leaseCalls: 0, doctorCalls: 0 };
    const layer = makePalliumSchedulerLive({ intervalMs: 15 * 60_000 }).pipe(
      Layer.provide(buildFakeContext({ events, counters })),
    );

    yield* Effect.gen(function* () {
      const scheduler = yield* PalliumScheduler;
      yield* scheduler.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(counters.indexCalls, 1);

      yield* PubSub.publish(events, {
        type: "thread.turn-diff-completed",
        payload: {},
      } as unknown as OrchestrationEvent);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.strictEqual(counters.indexCalls, 2, "wakeup triggered a second pass");
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

it.effect("does not index when the scheduler lease is held by another instance", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const counters = { indexCalls: 0, embedCalls: 0, leaseCalls: 0, doctorCalls: 0 };
    // The lease is NOT acquired on the first pass → no index work despite Pallium being available.
    const layer = makePalliumSchedulerLive({ intervalMs: 15 * 60_000 }).pipe(
      Layer.provide(buildFakeContext({ events, counters, leaseResults: [false] })),
    );

    yield* Effect.gen(function* () {
      const scheduler = yield* PalliumScheduler;
      yield* scheduler.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(counters.leaseCalls, 1, "lease was attempted");
      assert.strictEqual(counters.indexCalls, 0, "no index when lease not acquired");
      assert.strictEqual(counters.doctorCalls, 0, "no project probe when lease not acquired");
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

it.effect("performs no index work when Pallium is unavailable", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const counters = { indexCalls: 0, embedCalls: 0, leaseCalls: 0, doctorCalls: 0 };
    const layer = makePalliumSchedulerLive({ intervalMs: 15 * 60_000 }).pipe(
      Layer.provide(buildFakeContext({ events, counters, status: unavailableStatus })),
    );

    yield* Effect.gen(function* () {
      const scheduler = yield* PalliumScheduler;
      yield* scheduler.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(counters.indexCalls, 0, "no index when unavailable");
      assert.strictEqual(counters.embedCalls, 0, "no embed when unavailable");
      assert.strictEqual(counters.leaseCalls, 0, "no lease attempt when unavailable (cheap no-op)");
      assert.strictEqual(counters.doctorCalls, 0, "no doctor probe when unavailable");
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

// Builds the merged fake service context (everything the scheduler layer depends on) for a test.
function buildFakeContext(fakes: {
  readonly events: PubSub.PubSub<OrchestrationEvent>;
  readonly counters: Counters;
  readonly status?: PalliumStatus;
  readonly doctor?: PalliumDoctorResult;
  readonly leaseResults?: ReadonlyArray<boolean>;
}) {
  const status = fakes.status ?? availableStatus;
  const doctor = fakes.doctor ?? staleDoctor;

  const pallium = {
    status: Effect.succeed(status),
    version: unusedEffect,
    doctor: () =>
      Effect.sync(() => {
        fakes.counters.doctorCalls += 1;
        return doctor;
      }),
    index: unusedEffect,
    changedNow: unusedEffect,
    sessionsList: unusedEffect,
    decisions: unusedEffect,
    sessionsSearch: unusedEffect,
    sessionsSemantic: unusedEffect,
    sessionsEmbed: () =>
      Effect.sync(() => {
        fakes.counters.embedCalls += 1;
        return emptyEmbed;
      }),
  };

  const memory = {
    status: Effect.succeed({
      available: status.available,
      capabilities: status.capabilities,
      checkedAt: status.checkedAt,
    }),
    overview: unusedEffect,
    listFiles: unusedEffect,
    listSessions: unusedEffect,
    listDecisions: unusedEffect,
    search: unusedEffect,
    searchSemantic: unusedEffect,
    embedSessions: unusedEffect,
    index: () =>
      Effect.sync(() => {
        fakes.counters.indexCalls += 1;
        return emptyIndex;
      }),
  } satisfies MemoryServiceShape;

  const projectId = ProjectId.makeUnsafe("project-1");
  const projections = {
    getShellSnapshot: () => Effect.succeed(shellSnapshotWithProject(projectId)),
  } as unknown as ProjectionSnapshotQueryShape;

  const orchestrationEngine = {
    streamDomainEvents: Stream.fromPubSub(fakes.events),
  } as unknown as OrchestrationEngineShape;

  let leaseIndex = 0;
  const automationRepository = {
    tryAcquireSchedulerLease: () =>
      Effect.sync(() => {
        const result = fakes.leaseResults?.[leaseIndex] ?? true;
        leaseIndex += 1;
        fakes.counters.leaseCalls += 1;
        return result;
      }),
  } as unknown as AutomationRepositoryShape;

  return Layer.mergeAll(
    Layer.succeed(PalliumService, pallium as never),
    Layer.succeed(MemoryService, memory),
    Layer.succeed(ProjectionSnapshotQuery, projections),
    Layer.succeed(OrchestrationEngineService, orchestrationEngine),
    Layer.succeed(AutomationRepository, automationRepository),
  );
}
