import { Schema } from "effect";

/**
 * A Memory read/overview operation failed in a way the caller should surface (e.g. the project
 * could not be resolved, or a cache write failed). Note: Pallium being absent is NOT an error —
 * read methods fold absence into a valid empty result per the strict-optional prime directive.
 */
export class MemoryServiceError extends Schema.TaggedErrorClass<MemoryServiceError>()(
  "MemoryServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
