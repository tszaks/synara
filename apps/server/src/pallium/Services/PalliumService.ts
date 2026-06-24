import type {
  PalliumChangedNowResult,
  PalliumDecisionList,
  PalliumDoctorResult,
  PalliumSessionList,
  PalliumStatus,
  PalliumVersionResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PalliumServiceError, PalliumUnavailableError } from "../Errors.ts";

/**
 * The Pallium binary boundary as an Effect service.
 *
 * `status` is the prime directive: it can NEVER fail. An absent, too-old, or unreadable binary
 * resolves to `{ available: false, ... }` with all capabilities false, so the server boots
 * normally and the Memory feature stays hidden.
 *
 * `version`/`doctor` decode the underlying `pallium … --json` output and can fail (the binary is
 * missing or returned something unexpected); callers that want graceful absence should prefer
 * `status`.
 */
export interface PalliumServiceShape {
  /** Capability handshake. Memoized with a short TTL. Never fails. */
  readonly status: Effect.Effect<PalliumStatus, never>;
  readonly version: Effect.Effect<
    PalliumVersionResult,
    PalliumServiceError | PalliumUnavailableError
  >;
  readonly doctor: (input?: {
    readonly cwd?: string;
  }) => Effect.Effect<PalliumDoctorResult, PalliumServiceError | PalliumUnavailableError>;
  /** `pallium changed-now <repo> --json`: the working tree's changed files with risk + tests. */
  readonly changedNow: (input: {
    readonly cwd: string;
  }) => Effect.Effect<PalliumChangedNowResult, PalliumServiceError | PalliumUnavailableError>;
  /**
   * `pallium sessions list --limit N --json`: a top-level array of recent sessions from the
   * home-level session DB (NOT repo-scoped).
   */
  readonly sessionsList: (input?: {
    readonly limit?: number;
  }) => Effect.Effect<PalliumSessionList, PalliumServiceError | PalliumUnavailableError>;
  /**
   * `pallium decisions <query> <repo> --json`: a top-level array of decision notes matching `query`.
   * Pallium requires the query and hardcodes a limit of 10 (see GAP A).
   */
  readonly decisions: (input: {
    readonly query: string;
    readonly cwd?: string;
  }) => Effect.Effect<PalliumDecisionList, PalliumServiceError | PalliumUnavailableError>;
}

export class PalliumService extends ServiceMap.Service<PalliumService, PalliumServiceShape>()(
  "t3/pallium/Services/PalliumService",
) {}
