/**
 * Adds a partial index for the heartbeat completion-evaluation scan.
 *
 * `AutomationRepository.listRunsNeedingCompletionEvaluationRows` filters
 * `automation_runs` on `status = 'succeeded' AND finished_at IS NOT NULL` and
 * orders by `finished_at ASC, run_id ASC`. It runs on startup and after every
 * `reconcileActiveRuns` / `recoverPendingRuns` pass. None of the indexes from
 * migration 044 serve `(finished_at, run_id)` (the recovery index is keyed on
 * `lease_expires_at`), so this query degrades to a scan as runs accumulate.
 *
 * The index is keyed on `(finished_at, run_id)` — not `(status, finished_at)` —
 * because `status` is already pinned to `'succeeded'` by the partial `WHERE`, so
 * a leading `status` column would be dead weight. Including `run_id` lets the
 * index fully satisfy the `finished_at ASC, run_id ASC` ORDER BY without a
 * temp-b-tree sort of the rows that share a `finished_at`. It is a partial
 * index, not a covering one: the query selects ~20 columns, so SQLite still does
 * a row lookup; the index exists to drive the ordered LIMIT scan, not to avoid
 * the table read.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_completion_eval
    ON automation_runs (finished_at, run_id)
    WHERE status = 'succeeded'
  `;
});
