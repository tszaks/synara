import type { MemoryOverview, MemoryOverviewInput, MemoryStatus } from "@t3tools/contracts";
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
}

export class MemoryService extends ServiceMap.Service<MemoryService, MemoryServiceShape>()(
  "t3/memory/Services/MemoryService",
) {}
