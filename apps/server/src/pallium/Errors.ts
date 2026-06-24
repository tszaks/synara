import { Schema } from "effect";

/**
 * A Pallium command failed (non-zero exit, JSON parse/decode failure, timeout, or a rejected
 * subcommand). Mutating callers should surface this; read-only/status callers fold it into a
 * `available: false` result instead.
 */
export class PalliumServiceError extends Schema.TaggedErrorClass<PalliumServiceError>()(
  "PalliumServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * The Pallium binary is absent, not on PATH, or too old to honor the JSON contract. This is the
 * graceful-absence signal: `status` never fails, but mutating methods can fail with this so the
 * UI can show an "install Pallium" affordance rather than a generic error.
 */
export class PalliumUnavailableError extends Schema.TaggedErrorClass<PalliumUnavailableError>()(
  "PalliumUnavailableError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
