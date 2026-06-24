// Schema-only contracts for the optional Pallium-backed Memory feature.
//
// Two families live here:
//   1. Pallium output schemas (Pallium*Result) decode the `pallium … --json` stdout. They are
//      intentionally lenient (plain String/Number/Boolean, optional for omitempty fields) because
//      they decode an external binary's output, which must keep working across Pallium versions.
//   2. Memory contract schemas (the stable Synara-side shape) are mapped from the Pallium output
//      by the server. Keeping the two separate means a Pallium JSON change touches only the mapper,
//      not the WS contract.
//
// Per CLAUDE.md, packages/contracts is schema-only: no runtime logic here.

import { Schema } from "effect";

import { IsoDateTime } from "./baseSchemas";

// --- Pallium output schemas (decode `pallium … --json`) ------------------------------------------

// `pallium version --json` (cmd.VersionReport)
export const PalliumVersionResult = Schema.Struct({
  module: Schema.String,
  version: Schema.String,
  go_version: Schema.String,
  vcs_revision: Schema.optional(Schema.String),
  vcs_modified: Schema.optional(Schema.String),
  executable: Schema.optional(Schema.String),
});
export type PalliumVersionResult = typeof PalliumVersionResult.Type;

// One stored embedding space (sessionmemory.EmbeddingModel)
export const PalliumEmbeddingModel = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  dim: Schema.Number,
  count: Schema.Number,
});
export type PalliumEmbeddingModel = typeof PalliumEmbeddingModel.Type;

// Session-memory index stats (sessionmemory.Stats)
export const PalliumSessionStats = Schema.Struct({
  sessions: Schema.Number,
  events: Schema.Number,
  messages: Schema.Number,
  chunks: Schema.Number,
  embeddings: Schema.Number,
  models: Schema.optional(Schema.Array(PalliumEmbeddingModel)),
});
export type PalliumSessionStats = typeof PalliumSessionStats.Type;

// `pallium doctor --json` (cmd.DoctorReport). `index_status` is one of "missing" | "stale" |
// "indexed" today; kept as String so a new status can't break decoding.
export const PalliumDoctorResult = Schema.Struct({
  repo_root: Schema.String,
  repo_db_path: Schema.String,
  repo_db_exists: Schema.Boolean,
  index_status: Schema.String,
  indexed_branch: Schema.optional(Schema.String),
  last_indexed_commit: Schema.optional(Schema.String),
  indexed_at: Schema.optional(Schema.String),
  current_branch: Schema.optional(Schema.String),
  current_commit: Schema.optional(Schema.String),
  working_tree_dirty: Schema.Boolean,
  working_tree_file_count: Schema.Number,
  session_db_path: Schema.String,
  session_db_exists: Schema.Boolean,
  session_stats: PalliumSessionStats,
  embedding_model: Schema.String,
  embedding_backlog: Schema.Number,
  openai_key_available: Schema.Boolean,
  executable_path: Schema.optional(Schema.String),
  recommended_next_command: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.Array(Schema.String)),
});
export type PalliumDoctorResult = typeof PalliumDoctorResult.Type;

// --- Memory contract schemas (stable Synara-side shape) ------------------------------------------

// Capabilities the server derives from version + doctor to gate the UI.
export const PalliumCapabilities = Schema.Struct({
  // True once `pallium index` has run for the project (doctor.index_status === "indexed").
  indexed: Schema.Boolean,
  // True when the session store has embeddings available for semantic search.
  embeddings: Schema.Boolean,
  // True when an OpenAI key is present (a hosted embedding provider can run without local setup).
  openaiKeyAvailable: Schema.Boolean,
});
export type PalliumCapabilities = typeof PalliumCapabilities.Type;

// The capability-handshake result. `available: false` means Pallium is absent/too old/unreadable,
// in which case the Memory feature is hidden and Synara behaves exactly as it does today.
export const PalliumStatus = Schema.Struct({
  available: Schema.Boolean,
  binaryPath: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  capabilities: PalliumCapabilities,
  checkedAt: IsoDateTime,
  // Human-readable explanation when unavailable (e.g. "pallium not found on PATH").
  reason: Schema.optional(Schema.String),
});
export type PalliumStatus = typeof PalliumStatus.Type;
