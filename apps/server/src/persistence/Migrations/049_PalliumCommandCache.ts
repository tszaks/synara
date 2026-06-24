import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Memoizes `pallium … --json` output so the UI never re-spawns the binary per
  // request. Source of truth stays in Pallium's own SQLite; this is a projection.
  // Keyed on (command, args, project_id, index_epoch): a per-project epoch token
  // (Pallium index mtime / last_indexed_commit from `doctor`). Any epoch change
  // misses every old key for free; `expires_at` is the TTL backstop.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pallium_command_cache (
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      project_id TEXT NOT NULL,
      index_epoch TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (command, args, project_id, index_epoch)
    )
  `;

  // Backs the stale-epoch sweep: DELETE WHERE project_id = ? AND index_epoch != ?.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pallium_command_cache_epoch
    ON pallium_command_cache (project_id, index_epoch)
  `;

  // Backs per-project command lookups and invalidation.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pallium_command_cache_project_command
    ON pallium_command_cache (project_id, command)
  `;

  // Backs the expiry sweep: DELETE WHERE expires_at <= ?.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pallium_command_cache_expiry
    ON pallium_command_cache (expires_at)
  `;
});
