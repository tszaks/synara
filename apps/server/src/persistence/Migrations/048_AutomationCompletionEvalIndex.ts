/**
 * Adds a covering index for the heartbeat completion-evaluation scan.
 *
 * `AutomationRepository.listRunsNeedingCompletionEvaluationRows` filters
 * `automation_runs` on `status = 'succeeded' AND finished_at IS NOT NULL` and
 * orders by `finished_at ASC, run_id ASC`. It runs on startup and after every
 * `reconcileActiveRuns` / `recoverPendingRuns` pass. None of the indexes from
 * migration 044 cover `(status, finished_at)` (the recovery index is keyed on
 * `lease_expires_at`), so this query degrades to a scan as runs accumulate.
 *
 * A partial index on the succeeded rows keeps it small and matches the hot
 * predicate + ORDER BY. The join/`json_extract` predicates are intentionally
 * left out — the status+finished_at slice is the part that scales with volume.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_completion_eval
    ON automation_runs (status, finished_at)
    WHERE status = 'succeeded'
  `;
});
