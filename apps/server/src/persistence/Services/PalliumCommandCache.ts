/**
 * PalliumCommandCacheRepository - Repository interface for the Pallium command cache.
 *
 * Memoizes `pallium … --json` output in Synara's own SQLite so the UI never
 * re-spawns the binary per request. Pallium owns the source of truth on disk;
 * this table is a projection keyed on `(command, args, project_id, index_epoch)`.
 *
 * `index_epoch` is a per-project token (Pallium index mtime / last_indexed_commit
 * from `doctor`). Any epoch change misses every old key for free; a
 * `DELETE WHERE index_epoch != current` sweep reclaims space. `expires_at` is the
 * TTL backstop.
 *
 * @module PalliumCommandCacheRepository
 */
import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PalliumCommandCacheRepositoryError } from "../Errors.ts";

/**
 * A cached Pallium command result.
 *
 * `args` is the canonical (stable-serialized) argv key used for lookups, while
 * `args` decoded JSON and the result JSON are stored separately so the cached
 * payload survives schema-agnostic storage. Both JSON columns round-trip through
 * `Schema.fromJsonString` at the layer.
 */
export const PalliumCommandCacheEntry = Schema.Struct({
  command: Schema.String,
  args: Schema.String,
  projectId: ProjectId,
  indexEpoch: Schema.String,
  argsJson: Schema.Json,
  resultJson: Schema.Json,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type PalliumCommandCacheEntry = typeof PalliumCommandCacheEntry.Type;

export const GetPalliumCommandCacheInput = Schema.Struct({
  command: Schema.String,
  args: Schema.String,
  projectId: ProjectId,
  indexEpoch: Schema.String,
  /** Rows whose `expires_at` is at or before this instant are treated as misses. */
  now: IsoDateTime,
});
export type GetPalliumCommandCacheInput = typeof GetPalliumCommandCacheInput.Type;

export const PutPalliumCommandCacheInput = PalliumCommandCacheEntry;
export type PutPalliumCommandCacheInput = typeof PutPalliumCommandCacheInput.Type;

export const InvalidateStalePalliumEpochsInput = Schema.Struct({
  projectId: ProjectId,
  /** Keep rows at this epoch; delete every other epoch for the project. */
  currentIndexEpoch: Schema.String,
});
export type InvalidateStalePalliumEpochsInput = typeof InvalidateStalePalliumEpochsInput.Type;

export const SweepExpiredPalliumCommandCacheInput = Schema.Struct({
  /** Delete rows whose `expires_at` is at or before this instant. */
  now: IsoDateTime,
});
export type SweepExpiredPalliumCommandCacheInput = typeof SweepExpiredPalliumCommandCacheInput.Type;

/**
 * PalliumCommandCacheRepositoryShape - Service API for the Pallium command cache.
 */
export interface PalliumCommandCacheRepositoryShape {
  /**
   * Read a cached command result, or `None` on a miss (absent, wrong epoch, or
   * expired).
   */
  readonly get: (
    input: GetPalliumCommandCacheInput,
  ) => Effect.Effect<Option.Option<PalliumCommandCacheEntry>, PalliumCommandCacheRepositoryError>;

  /**
   * Insert or replace a cached command result.
   *
   * Upserts on the `(command, args, project_id, index_epoch)` primary key.
   */
  readonly put: (
    input: PutPalliumCommandCacheInput,
  ) => Effect.Effect<void, PalliumCommandCacheRepositoryError>;

  /**
   * Delete every cached row for a project whose epoch differs from the current
   * one. Called after an index refresh so old keys do not linger.
   */
  readonly invalidateStaleEpochs: (
    input: InvalidateStalePalliumEpochsInput,
  ) => Effect.Effect<void, PalliumCommandCacheRepositoryError>;

  /**
   * Delete every cached row whose TTL has elapsed.
   */
  readonly sweepExpired: (
    input: SweepExpiredPalliumCommandCacheInput,
  ) => Effect.Effect<void, PalliumCommandCacheRepositoryError>;
}

/**
 * PalliumCommandCacheRepository - Service tag for Pallium command-cache persistence.
 */
export class PalliumCommandCacheRepository extends ServiceMap.Service<
  PalliumCommandCacheRepository,
  PalliumCommandCacheRepositoryShape
>()("t3/persistence/Services/PalliumCommandCache/PalliumCommandCacheRepository") {}
