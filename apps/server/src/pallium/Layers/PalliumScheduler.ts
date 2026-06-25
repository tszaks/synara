import type { OrchestrationEvent, PalliumDoctorResult } from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Queue, Stream } from "effect";

import { MemoryService } from "../../memory/Services/MemoryService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { redactedErrorMessage } from "../redactSecrets.ts";
import { PalliumService } from "../Services/PalliumService.ts";
import { PalliumScheduler, type PalliumSchedulerShape } from "../Services/PalliumScheduler.ts";

// The refresh cadence is measured in MINUTES, never sub-second — this loop is a background
// freshness backstop, not a hot path, and the repo's no-global-sub-second-loop rule forbids a
// tighter tick. The lower bound is the minimum a wakeup-or-clamp can produce; the upper bound is
// the idle sleep when nothing is happening. A wakeup (a turn finished with a diff) races the sleep,
// so an index refresh still fires promptly after real work.
const PALLIUM_REFRESH_INTERVAL_MS = 15 * 60_000;
const PALLIUM_REFRESH_INTERVAL_MS_MIN = 60_000;

// How long a single scheduler pass holds the lease. Generous enough to cover a slow multi-project
// index without another instance stealing the lease mid-pass. Mirrors the automation lease TTL.
const SCHEDULER_LEASE_TTL_MS = 120_000;

const LEASE_KEY = "pallium-scheduler";

function isoNow(): string {
  return new Date().toISOString();
}

// A diff-producing turn means files just changed on disk, so the project's index is now stale and a
// refresh should fire promptly. Message/token streams are intentionally NOT woken on (too noisy);
// this mirrors AutomationScheduler.shouldWakeScheduler's "real work finished" filter.
function shouldWakeScheduler(event: OrchestrationEvent): boolean {
  return event.type === "thread.turn-diff-completed";
}

// A project's index is stale when it was never indexed, the index is explicitly stale, or HEAD has
// moved past the last indexed commit. `current_commit`/`last_indexed_commit` may be absent on a
// fresh/odd repo; when both are present and differ, that's a moved HEAD. A dirty working tree alone
// does not force a re-index (changed-now already reflects it); only committed movement does.
function isIndexStale(doctor: PalliumDoctorResult): boolean {
  if (doctor.index_status !== "indexed") {
    return true;
  }
  const indexed = doctor.last_indexed_commit;
  const current = doctor.current_commit;
  if (indexed !== undefined && current !== undefined) {
    return indexed !== current;
  }
  return false;
}

export interface PalliumSchedulerLiveOptions {
  /** Idle sleep upper bound, clamped to the minute floor. Test seam. */
  readonly intervalMs?: number;
}

export const makePalliumSchedulerLive = (options?: PalliumSchedulerLiveOptions) =>
  Layer.effect(
    PalliumScheduler,
    Effect.gen(function* () {
      const pallium = yield* PalliumService;
      const memory = yield* MemoryService;
      const projections = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const automationRepository = yield* AutomationRepository;

      // Clamp the idle interval into the minute range so a misconfigured/test value can never make
      // this a sub-second loop.
      const intervalMs = Math.min(
        PALLIUM_REFRESH_INTERVAL_MS,
        Math.max(
          PALLIUM_REFRESH_INTERVAL_MS_MIN,
          options?.intervalMs ?? PALLIUM_REFRESH_INTERVAL_MS,
        ),
      );

      // Refresh a single project: re-index the repo (which invalidates its stale cache epochs) and
      // then best-effort embed any new session backlog. Both are swallowed independently so one
      // failing project (or an embedding provider that isn't configured) never aborts the others.
      const refreshProject = (projectId: Parameters<typeof memory.index>[0]["projectId"]) =>
        memory.index({ projectId }).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("pallium scheduler index refresh failed", {
              projectId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

      // Best-effort refresh of session indexing (embed the backlog into the configured space). This
      // is gated server-side and may fail when embeddings aren't configured; swallow so it never
      // aborts the pass.
      const refreshSessions = pallium.sessionsEmbed().pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("pallium scheduler session refresh failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );

      // One project's freshness check: doctor probes the repo (a doctor failure means it's not a
      // usable git repo / not readable, so skip it quietly), and a stale index triggers a refresh.
      const refreshProjectIfStale = (project: {
        readonly id: Parameters<typeof refreshProject>[0];
        readonly workspaceRoot: string;
      }) =>
        pallium.doctor({ cwd: project.workspaceRoot }).pipe(
          Effect.flatMap((doctor) =>
            isIndexStale(doctor) ? refreshProject(project.id) : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("pallium scheduler project probe failed", {
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
              cause: Cause.pretty(cause),
            }),
          ),
        );

      // A single scheduler pass. No-ops cheaply when Pallium is unavailable, then takes the DB lease
      // (multi-instance safe), enumerates projects, and refreshes any stale index. Per-project
      // errors are swallowed inside refreshProjectIfStale so one bad project can't abort the rest.
      const runPass = Effect.gen(function* () {
        const status = yield* pallium.status;
        if (!status.available) {
          // Cheapest possible path: status never spawns more than the memoized handshake.
          return;
        }

        const now = isoNow();
        const nowMs = Date.parse(now);
        const leaseExpiresAt = new Date(
          (Number.isFinite(nowMs) ? nowMs : Date.now()) + SCHEDULER_LEASE_TTL_MS,
        ).toISOString();
        const acquired = yield* automationRepository.tryAcquireSchedulerLease({
          leaseKey: LEASE_KEY,
          ownerId: `pallium-scheduler:${process.pid}`,
          now,
          leaseExpiresAt,
        });
        if (!acquired) {
          // Another instance holds the lease; expected under multi-instance. Skip this pass so we
          // never double-run an index.
          yield* Effect.logDebug("pallium scheduler lease not acquired");
          return;
        }

        const snapshot = yield* projections.getShellSnapshot();
        yield* Effect.forEach(snapshot.projects, refreshProjectIfStale, { concurrency: 1 });
        yield* refreshSessions;
      });

      // The whole pass is defensively wrapped: any unexpected failure (lease error, snapshot error)
      // is logged and swallowed so the loop survives to the next tick.
      const runPassSafely = runPass.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pallium scheduler pass failed", {
            cause: redactedErrorMessage(Cause.squash(cause)),
          }),
        ),
      );

      const start: PalliumSchedulerShape["start"] = () =>
        Effect.forkScoped(
          Effect.gen(function* () {
            const wakeups = yield* Queue.sliding<void>(1);
            yield* orchestrationEngine.streamDomainEvents.pipe(
              Stream.filter(shouldWakeScheduler),
              Stream.runForEach(() => Queue.offer(wakeups, undefined).pipe(Effect.asVoid)),
              Effect.forkScoped,
            );

            while (true) {
              yield* runPassSafely;
              // Real work (a diff-producing turn) wakes the loop early; otherwise it sleeps the full
              // minute-range interval.
              yield* Effect.sleep(Duration.millis(intervalMs)).pipe(
                Effect.raceFirst(Queue.take(wakeups)),
                Effect.asVoid,
              );
            }
          }),
        ).pipe(Effect.asVoid);

      return { start } satisfies PalliumSchedulerShape;
    }),
  );

export const PalliumSchedulerLive = makePalliumSchedulerLive();
