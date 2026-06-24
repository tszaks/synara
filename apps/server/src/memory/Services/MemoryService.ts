import type {
  MemoryDecisionList,
  MemoryFileList,
  MemoryListDecisionsInput,
  MemoryListFilesInput,
  MemoryListSessionsInput,
  MemoryOverview,
  MemoryOverviewInput,
  MemorySearchInput,
  MemorySearchResultList,
  MemorySessionList,
  MemoryStatus,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { MemoryServiceError } from "../Errors.ts";

/**
 * MemoryService is the only thing the WS layer calls for the Memory feature. It sits above
 * PalliumService, owns the projection/cache, and returns stable Memory* contract shapes so the
 * web client never sees Pallium's output schemas.
 *
 * Prime directive (strict-optional): Memory is optional. Read methods consult PalliumService.status
 * first; when `available: false` they return an empty-but-valid result and never throw, so the UI
 * renders an "install Pallium" empty state instead of an error toast.
 */
export interface MemoryServiceShape {
  /** Capability handshake mapped from PalliumService.status. Never fails. */
  readonly status: Effect.Effect<MemoryStatus, never>;
  /**
   * Per-project (or no-project) overview. Returns a zeroed, valid overview when Pallium is
   * unavailable. Memoized by index epoch so a repeat call within one epoch never re-spawns
   * the binary.
   */
  readonly overview: (
    input?: MemoryOverviewInput,
  ) => Effect.Effect<MemoryOverview, MemoryServiceError>;
  /**
   * The project's changed files (from `pallium changed-now`), with risk + suggested tests. Returns
   * an empty, valid list when Pallium is unavailable or the project is unknown. Memoized by index
   * epoch.
   */
  readonly listFiles: (
    input?: MemoryListFilesInput,
  ) => Effect.Effect<MemoryFileList, MemoryServiceError>;
  /**
   * Recent coding sessions (from `pallium sessions list`). Sessions live in the home-level DB, so
   * this is not repo-scoped; it is cached by command+args with a TTL backstop. Returns an empty,
   * valid list when Pallium is unavailable.
   */
  readonly listSessions: (
    input?: MemoryListSessionsInput,
  ) => Effect.Effect<MemorySessionList, MemoryServiceError>;
  /**
   * Decision notes matching a query (from `pallium decisions`). The query is REQUIRED and Pallium
   * caps results at ~10 (GAP A). Returns an empty, valid list when Pallium is unavailable or the
   * project is unknown.
   */
  readonly listDecisions: (
    input: MemoryListDecisionsInput,
  ) => Effect.Effect<MemoryDecisionList, MemoryServiceError>;
  /**
   * Lexical (keyword) search over recent sessions (from `pallium sessions search`). Pure lexical —
   * works with embeddings OFF. Returns an empty, valid list when Pallium is unavailable or the query
   * is empty. Cached by query+limit with a TTL backstop.
   */
  readonly search: (
    input: MemorySearchInput,
  ) => Effect.Effect<MemorySearchResultList, MemoryServiceError>;
}

export class MemoryService extends ServiceMap.Service<MemoryService, MemoryServiceShape>()(
  "t3/memory/Services/MemoryService",
) {}
