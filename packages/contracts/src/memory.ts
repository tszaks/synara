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

import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas";

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

// One changed file from `pallium changed-now --json` (analysis.ChangedNowFile). `suggested_tests`
// and `blast_radius` are plain string arrays in Go (no omitempty) but kept optional here so a null
// or omitted array can't break decoding.
export const PalliumChangedNowFile = Schema.Struct({
  path: Schema.String,
  working_tree_status: Schema.String,
  risk_level: Schema.String,
  suggested_tests: Schema.optional(Schema.NullishOr(Schema.Array(Schema.String))),
  blast_radius: Schema.optional(Schema.NullishOr(Schema.Array(Schema.String))),
});
export type PalliumChangedNowFile = typeof PalliumChangedNowFile.Type;

// `pallium changed-now --json` (analysis.ChangedNowReport). Only `files` is consumed today; the rest
// of the report (summary, freshness, evidence, task) is decoded leniently and ignored so a Pallium
// shape change in those sections can't break the file list.
export const PalliumChangedNowResult = Schema.Struct({
  summary: Schema.optional(Schema.String),
  index_status: Schema.optional(Schema.String),
  recommended_next_command: Schema.optional(Schema.String),
  files: Schema.optional(Schema.NullishOr(Schema.Array(PalliumChangedNowFile))),
});
export type PalliumChangedNowResult = typeof PalliumChangedNowResult.Type;

// One session from `pallium sessions list --json` (sessionmemory.Session). The command emits a
// top-level array of these. Only id/title/timestamps/cwd are surfaced to the UI today; the rest are
// decoded leniently (optional) so a new/removed Pallium column can't break the list.
export const PalliumSession = Schema.Struct({
  id: Schema.String,
  machine: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  first_user_message: Schema.optional(Schema.String),
  last_agent_message: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  model_provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  cli_version: Schema.optional(Schema.String),
  git_branch: Schema.optional(Schema.String),
  git_origin_url: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  tokens_used: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.String),
});
export type PalliumSession = typeof PalliumSession.Type;

// `pallium sessions list --json` returns a top-level array of sessions (no envelope).
export const PalliumSessionList = Schema.NullishOr(Schema.Array(PalliumSession));
export type PalliumSessionList = typeof PalliumSessionList.Type;

// One decision note from `pallium decisions <query> <repo> --json` (analysis.Decision). The command
// emits a top-level array of these.
export const PalliumDecision = Schema.Struct({
  source_type: Schema.optional(Schema.String),
  source_ref: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  committed_at: Schema.optional(Schema.String),
});
export type PalliumDecision = typeof PalliumDecision.Type;

// `pallium decisions --json` returns a top-level array of decisions (no envelope).
export const PalliumDecisionList = Schema.NullishOr(Schema.Array(PalliumDecision));
export type PalliumDecisionList = typeof PalliumDecisionList.Type;

// One hit from `pallium sessions search <query> --json` (sessionmemory.SearchResult). The Go struct
// EMBEDS Session, so its fields (id/title/cwd/…) appear flattened at the top level alongside the
// search-specific rank/score/signals. We re-use PalliumSession's fields here (all optional except
// id) and add the three search fields; all three carry `omitempty` in Go, so they are optional. This
// path is pure lexical (the default, non-hybrid Search) and uses NO embeddings.
export const PalliumSessionSearchResult = Schema.Struct({
  ...PalliumSession.fields,
  rank: Schema.optional(Schema.Number),
  score: Schema.optional(Schema.Number),
  signals: Schema.optional(Schema.NullishOr(Schema.Array(Schema.String))),
});
export type PalliumSessionSearchResult = typeof PalliumSessionSearchResult.Type;

// `pallium sessions search --json` returns a top-level array of results (no envelope).
export const PalliumSessionSearchList = Schema.NullishOr(Schema.Array(PalliumSessionSearchResult));
export type PalliumSessionSearchList = typeof PalliumSessionSearchList.Type;

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

// --- Memory WS contract schemas (the stable Synara-side WS API) ----------------------------------
//
// These are the schemas that travel over the WebSocket surface. The server maps Pallium output
// (PalliumStatus / PalliumDoctorResult above) into these shapes. Keeping them distinct from the
// Pallium output schemas means a Pallium JSON change touches only the server-side mapper, never
// the WS contract the web client depends on.

// `memory.status` input. Status is global (a capability handshake), so it takes no arguments.
export const MemoryStatusInput = Schema.Struct({});
export type MemoryStatusInput = typeof MemoryStatusInput.Type;

// `memory.status` result: the WS-facing capability handshake. `available: false` means Pallium is
// absent/too old/unreadable; the web client hides the Memory feature and Synara behaves as today.
export const MemoryStatus = Schema.Struct({
  available: Schema.Boolean,
  version: Schema.optional(Schema.String),
  capabilities: PalliumCapabilities,
  checkedAt: IsoDateTime,
  // Human-readable explanation when unavailable (e.g. "pallium not found on PATH").
  reason: Schema.optional(Schema.String),
});
export type MemoryStatus = typeof MemoryStatus.Type;

// `memory.overview` input. An optional project scopes the overview to one repo; omitted means the
// status-only / no-repo overview (a zeroed, valid result).
export const MemoryOverviewInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type MemoryOverviewInput = typeof MemoryOverviewInput.Type;

// One stored embedding space, surfaced to the UI (mapped from PalliumEmbeddingModel).
export const MemoryEmbeddingModel = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  dim: NonNegativeInt,
  count: NonNegativeInt,
});
export type MemoryEmbeddingModel = typeof MemoryEmbeddingModel.Type;

// Index freshness, mapped from doctor. `indexStatus` is one of "missing" | "stale" | "indexed"
// today but kept as String so a new Pallium status can't break decoding.
export const MemoryIndexStatus = Schema.String;
export type MemoryIndexStatus = typeof MemoryIndexStatus.Type;

// `memory.overview` result: the counts + freshness the overview panel renders. When Pallium is
// unavailable (or no project is indexed) the server returns a valid, zeroed overview rather than
// failing, so the UI shows an empty/install state instead of an error toast.
export const MemoryOverview = Schema.Struct({
  // False mirrors MemoryStatus.available so the panel can short-circuit to the empty state.
  available: Schema.Boolean,
  indexStatus: MemoryIndexStatus,
  // True once `pallium index` has run for the project (doctor.index_status === "indexed").
  indexed: Schema.Boolean,
  // Last successful index time (doctor.indexed_at) and the commit it covered, when known.
  lastIndexedAt: Schema.optional(Schema.String),
  lastIndexedCommit: Schema.optional(Schema.String),
  // True when the working tree has uncommitted changes since the last index.
  workingTreeDirty: Schema.Boolean,
  counts: Schema.Struct({
    sessions: NonNegativeInt,
    events: NonNegativeInt,
    messages: NonNegativeInt,
    chunks: NonNegativeInt,
    embeddings: NonNegativeInt,
    workingTreeFiles: NonNegativeInt,
  }),
  embeddingModels: Schema.Array(MemoryEmbeddingModel),
  // Sessions not yet embedded (doctor.embedding_backlog). Zero when embeddings are off/unused.
  embeddingBacklog: NonNegativeInt,
});
export type MemoryOverview = typeof MemoryOverview.Type;

// --- memory.listFiles (changed files) ------------------------------------------------------------
//
// v1 scopes the Files panel to the working tree's CHANGED files (`pallium changed-now`). A full
// per-project file catalog would need a new Pallium command; that is future work.

// `memory.listFiles` input. An optional project scopes the list to one repo; omitted returns an
// empty list (no repo to inspect).
export const MemoryListFilesInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type MemoryListFilesInput = typeof MemoryListFilesInput.Type;

// One changed file, surfaced to the UI (mapped from PalliumChangedNowFile).
export const MemoryFile = Schema.Struct({
  path: Schema.String,
  // Git porcelain-ish status from changed-now (e.g. "modified", "added").
  workingTreeStatus: Schema.String,
  // Pallium's risk assessment for editing this file (e.g. "low" | "medium" | "high"). Kept as a
  // plain String so a new risk band can't break decoding.
  riskLevel: Schema.String,
  suggestedTests: Schema.Array(Schema.String),
  blastRadius: Schema.Array(Schema.String),
});
export type MemoryFile = typeof MemoryFile.Type;

// `memory.listFiles` result. `available: false` mirrors MemoryStatus so the panel short-circuits to
// the empty state; the list is empty when Pallium is unavailable or the project is unknown.
export const MemoryFileList = Schema.Struct({
  available: Schema.Boolean,
  files: Schema.Array(MemoryFile),
});
export type MemoryFileList = typeof MemoryFileList.Type;

// --- memory.listSessions -------------------------------------------------------------------------

// `memory.listSessions` input. `limit` caps how many recent sessions Pallium returns. Sessions live
// in the home-level session DB, so this is NOT project-scoped (kept optional for symmetry/future
// filtering).
export const MemoryListSessionsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  limit: Schema.optional(NonNegativeInt),
});
export type MemoryListSessionsInput = typeof MemoryListSessionsInput.Type;

// One stored coding session, surfaced to the UI (mapped from PalliumSession). Only the fields the
// list view renders are carried; detail (transcript, files touched) is a future per-session method.
export const MemorySession = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
export type MemorySession = typeof MemorySession.Type;

// `memory.listSessions` result. `available: false` mirrors MemoryStatus; the list is empty when
// Pallium is unavailable.
export const MemorySessionList = Schema.Struct({
  available: Schema.Boolean,
  sessions: Schema.Array(MemorySession),
});
export type MemorySessionList = typeof MemorySessionList.Type;

// --- memory.listDecisions ------------------------------------------------------------------------
//
// GAP A (v1 limitation): Pallium's `decisions` subcommand REQUIRES a query and hardcodes a limit of
// 10 — there is no "list all decisions" mode. So `memory.listDecisions` takes a required query and
// returns at most ~10 matches. A browsable, unfiltered Decisions panel needs new Pallium work
// (`decisions --all --limit N`); that is future work.

// `memory.listDecisions` input. `query` is required (see GAP A above). An optional project scopes
// the search to one repo's decision notes.
export const MemoryListDecisionsInput = Schema.Struct({
  query: Schema.String,
  projectId: Schema.optional(ProjectId),
});
export type MemoryListDecisionsInput = typeof MemoryListDecisionsInput.Type;

// One decision note, surfaced to the UI (mapped from PalliumDecision).
export const MemoryDecision = Schema.Struct({
  sourceType: Schema.optional(Schema.String),
  sourceRef: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  committedAt: Schema.optional(Schema.String),
});
export type MemoryDecision = typeof MemoryDecision.Type;

// `memory.listDecisions` result. `available: false` mirrors MemoryStatus; the list is empty when
// Pallium is unavailable, the project is unknown, or nothing matched the query.
export const MemoryDecisionList = Schema.Struct({
  available: Schema.Boolean,
  decisions: Schema.Array(MemoryDecision),
});
export type MemoryDecisionList = typeof MemoryDecisionList.Type;

// --- memory.search (lexical session search) ------------------------------------------------------
//
// Lexical (keyword) search over the home-level session DB via `pallium sessions search <query>`. It
// uses the default, NON-hybrid Search, which is pure lexical and needs NO embeddings — so this path
// works regardless of embedding setup. Sessions live in the home DB, so this is NOT repo-scoped;
// `projectId` is kept optional for symmetry / future filtering.

// `memory.search` input. `query` is the lexical query. `limit` caps results (Pallium defaults to 10).
export const MemorySearchInput = Schema.Struct({
  query: Schema.String,
  projectId: Schema.optional(ProjectId),
  limit: Schema.optional(NonNegativeInt),
});
export type MemorySearchInput = typeof MemorySearchInput.Type;

// One search hit, surfaced to the UI (mapped from PalliumSessionSearchResult). Carries the same
// session fields the list view renders, plus the lexical match signals (score/signals). `rank` is a
// Pallium-internal float (BM25-ish) intentionally not surfaced; `score` is the integer match score.
export const MemorySearchResult = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  // The integer lexical match score (sessionmemory.SearchResult.score). Omitted when Pallium did not
  // report one.
  score: Schema.optional(NonNegativeInt),
  // Why this session matched (e.g. matched fields/terms). Empty when Pallium reported none.
  signals: Schema.Array(Schema.String),
});
export type MemorySearchResult = typeof MemorySearchResult.Type;

// `memory.search` result. `available: false` mirrors MemoryStatus; the list is empty when Pallium is
// unavailable, the query is empty, or nothing matched.
export const MemorySearchResultList = Schema.Struct({
  available: Schema.Boolean,
  results: Schema.Array(MemorySearchResult),
});
export type MemorySearchResultList = typeof MemorySearchResultList.Type;
