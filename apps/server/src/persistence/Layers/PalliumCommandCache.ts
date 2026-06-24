import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetPalliumCommandCacheInput,
  InvalidateStalePalliumEpochsInput,
  PalliumCommandCacheEntry,
  PalliumCommandCacheRepository,
  type PalliumCommandCacheRepositoryShape,
  PutPalliumCommandCacheInput,
  SweepExpiredPalliumCommandCacheInput,
} from "../Services/PalliumCommandCache.ts";

// Stored shape: the two JSON columns round-trip through `Schema.fromJsonString`,
// so callers read/write JS values while SQLite holds serialized text.
const PalliumCommandCacheDbRow = Schema.Struct({
  command: PalliumCommandCacheEntry.fields.command,
  args: PalliumCommandCacheEntry.fields.args,
  projectId: PalliumCommandCacheEntry.fields.projectId,
  indexEpoch: PalliumCommandCacheEntry.fields.indexEpoch,
  argsJson: Schema.fromJsonString(Schema.Json),
  resultJson: Schema.fromJsonString(Schema.Json),
  createdAt: PalliumCommandCacheEntry.fields.createdAt,
  expiresAt: PalliumCommandCacheEntry.fields.expiresAt,
});

const makePalliumCommandCacheRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findEntry = SqlSchema.findOneOption({
    Request: GetPalliumCommandCacheInput,
    Result: PalliumCommandCacheDbRow,
    execute: ({ command, args, projectId, indexEpoch, now }) =>
      sql`
        SELECT
          command,
          args,
          project_id AS "projectId",
          index_epoch AS "indexEpoch",
          args_json AS "argsJson",
          result_json AS "resultJson",
          created_at AS "createdAt",
          expires_at AS "expiresAt"
        FROM pallium_command_cache
        WHERE command = ${command}
          AND args = ${args}
          AND project_id = ${projectId}
          AND index_epoch = ${indexEpoch}
          AND expires_at > ${now}
      `,
  });

  const upsertEntry = SqlSchema.void({
    Request: PalliumCommandCacheDbRow,
    execute: (entry) =>
      sql`
        INSERT INTO pallium_command_cache (
          command,
          args,
          project_id,
          index_epoch,
          args_json,
          result_json,
          created_at,
          expires_at
        )
        VALUES (
          ${entry.command},
          ${entry.args},
          ${entry.projectId},
          ${entry.indexEpoch},
          ${entry.argsJson},
          ${entry.resultJson},
          ${entry.createdAt},
          ${entry.expiresAt}
        )
        ON CONFLICT (command, args, project_id, index_epoch)
        DO UPDATE SET
          args_json = excluded.args_json,
          result_json = excluded.result_json,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `,
  });

  const invalidateStaleEpochsRow = SqlSchema.void({
    Request: InvalidateStalePalliumEpochsInput,
    execute: ({ projectId, currentIndexEpoch }) =>
      sql`
        DELETE FROM pallium_command_cache
        WHERE project_id = ${projectId}
          AND index_epoch != ${currentIndexEpoch}
      `,
  });

  const sweepExpiredRow = SqlSchema.void({
    Request: SweepExpiredPalliumCommandCacheInput,
    execute: ({ now }) =>
      sql`
        DELETE FROM pallium_command_cache
        WHERE expires_at <= ${now}
      `,
  });

  const get: PalliumCommandCacheRepositoryShape["get"] = (input) =>
    findEntry(input).pipe(
      Effect.mapError(toPersistenceSqlError("PalliumCommandCacheRepository.get:query")),
    );

  const put: PalliumCommandCacheRepositoryShape["put"] = (input: PutPalliumCommandCacheInput) =>
    upsertEntry(input).pipe(
      Effect.mapError(toPersistenceSqlError("PalliumCommandCacheRepository.put:query")),
    );

  const invalidateStaleEpochs: PalliumCommandCacheRepositoryShape["invalidateStaleEpochs"] = (
    input,
  ) =>
    invalidateStaleEpochsRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("PalliumCommandCacheRepository.invalidateStaleEpochs:query"),
      ),
    );

  const sweepExpired: PalliumCommandCacheRepositoryShape["sweepExpired"] = (input) =>
    sweepExpiredRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PalliumCommandCacheRepository.sweepExpired:query")),
    );

  return {
    get,
    put,
    invalidateStaleEpochs,
    sweepExpired,
  } satisfies PalliumCommandCacheRepositoryShape;
});

export const PalliumCommandCacheRepositoryLive = Layer.effect(
  PalliumCommandCacheRepository,
  makePalliumCommandCacheRepository,
);
