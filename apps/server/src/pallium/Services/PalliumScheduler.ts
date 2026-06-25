import { Effect, Scope, ServiceMap } from "effect";

/**
 * The automatic background indexing scheduler. This is the "automatic" north-star piece of Memory:
 * it keeps each project's Pallium index fresh without the user ever running `index` by hand.
 *
 * It is cloned from {@link AutomationScheduler}: a single `Effect.forkScoped` loop that sleeps
 * (clamped to the minute range, never sub-second) and wakes early when real work finishes (a turn
 * produced a diff). A DB scheduler lease keeps it multi-instance safe, and every pass no-ops cheaply
 * when Pallium is unavailable.
 */
export interface PalliumSchedulerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class PalliumScheduler extends ServiceMap.Service<PalliumScheduler, PalliumSchedulerShape>()(
  "t3/pallium/Services/PalliumScheduler",
) {}
