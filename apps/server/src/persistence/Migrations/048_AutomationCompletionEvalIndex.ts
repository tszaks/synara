/**
 * Adds a partial index for the heartbeat completion-evaluation scan.
 *
 * `AutomationRepository.listRunsNeedingCompletionEvaluationRows` filters
 * `automation_runs` on `status = 'succeeded' AND finished_at IS NOT NULL`, keeps
 * only rows whose completion evaluation has not been written yet
 * (`result_json IS NULL OR json_type(result_json, '$.completionEvaluation') IS NULL`),
 * and orders by `finished_at ASC, run_id ASC`. It runs on startup and after every
 * `reconcileActiveRuns` / `recoverPendingRuns` pass, so it must stay cheap as the
 * succeeded-run history grows.
 *
 * Design:
 * - keyed on `(finished_at, run_id)` so the index fully serves the ORDER BY (no
 *   temp b-tree for the tie group) — `status` is omitted because the partial
 *   `WHERE` already pins it to `'succeeded'`.
 * - the partial `WHERE` mirrors the query's unevaluated-run predicate, so once a
 *   run's `completionEvaluation` is written the row drops out of the index. That
 *   keeps the index limited to runs still pending evaluation (usually ~none), so
 *   startup/reconcile no longer walks the full evaluated-run history, and the
 *   global index can't divert per-thread probes that look for active statuses.
 *
 * It is a partial index, not a covering one: the query reads ~20 columns, so
 * SQLite still does a row lookup; the index exists to drive the ordered LIMIT
 * scan over pending rows, not to avoid the table read.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_completion_eval
    ON automation_runs (finished_at, run_id)
    WHERE status = 'succeeded'
      AND (result_json IS NULL OR json_type(result_json, '$.completionEvaluation') IS NULL)
  `;
});
