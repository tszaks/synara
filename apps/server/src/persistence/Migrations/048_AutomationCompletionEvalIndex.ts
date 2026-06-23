/**
 * Adds an index for the heartbeat completion-evaluation scan.
 *
 * `AutomationRepository.listRunsNeedingCompletionEvaluationRows` filters
 * `automation_runs` on `status = 'succeeded' AND finished_at IS NOT NULL` and
 * orders by `finished_at ASC, run_id ASC`. It runs on startup and after every
 * `reconcileActiveRuns` / `recoverPendingRuns` pass, so it must stay cheap as
 * the run history grows.
 *
 * The index is keyed `(status, finished_at, run_id)`:
 * - `status` leads so the planner can seek `status = 'succeeded'` (equality) and
 *   then read the matching rows already ordered by `finished_at, run_id`. Without
 *   a leading `status` the planner keeps choosing migration 044's
 *   `idx_automation_runs_recovery (status, lease_expires_at)` and adds a temp
 *   b-tree for the ORDER BY (verified with EXPLAIN QUERY PLAN), so the index
 *   would not be used at all.
 * - `finished_at, run_id` then satisfy the ORDER BY without a sort, and let the
 *   LIMIT stop early.
 *
 * Deliberately NOT a partial index: a `WHERE` predicate referencing
 * `result_json` (e.g. `json_type(result_json, '$.completionEvaluation') IS NULL`)
 * would make `CREATE INDEX` evaluate `json_type` over every existing row, so a
 * single legacy/malformed `result_json` value would fail the migration. Keeping
 * the index unconditional avoids that risk; ineligible runs (non-ai or
 * already-evaluated) are filtered cheaply by the query's own predicates after the
 * ordered seek. A partial `WHERE status = 'succeeded'` was also rejected: it
 * makes `status` a constant leading column, which the planner then declines to
 * use for the equality seek.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_completion_eval
    ON automation_runs (status, finished_at, run_id)
  `;
});
