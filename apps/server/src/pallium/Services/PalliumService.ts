import type { PalliumDoctorResult, PalliumStatus, PalliumVersionResult } from "@t3tools/contracts";
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
}

export class PalliumService extends ServiceMap.Service<PalliumService, PalliumServiceShape>()(
  "t3/pallium/Services/PalliumService",
) {}
