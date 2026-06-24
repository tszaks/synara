import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { PalliumCommandCacheRepositoryLive } from "./PalliumCommandCache.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  PalliumCommandCacheRepository,
  type PalliumCommandCacheEntry,
} from "../Services/PalliumCommandCache.ts";

const layer = it.layer(
  PalliumCommandCacheRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.makeUnsafe("project-1");

const baseEntry = {
  command: "doctor",
  args: "--json",
  projectId,
  indexEpoch: "epoch-1",
  argsJson: { repo: "/tmp/repo" },
  resultJson: { index_status: "indexed", embedding_backlog: 0 },
  createdAt: "2026-06-24T10:00:00.000Z",
  expiresAt: "2026-06-24T11:00:00.000Z",
} satisfies PalliumCommandCacheEntry;

const getInput = {
  command: baseEntry.command,
  args: baseEntry.args,
  projectId: baseEntry.projectId,
  indexEpoch: baseEntry.indexEpoch,
  now: "2026-06-24T10:30:00.000Z",
} as const;

layer("PalliumCommandCacheRepository", (it) => {
  it.effect("applies the migration idempotently", () =>
    Effect.gen(function* () {
      // SqlitePersistenceMemory already ran migrations; re-running must be a no-op.
      yield* runMigrations();
      yield* runMigrations();

      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'pallium_command_cache'
      `;
      assert.strictEqual(tables.length, 1);
    }),
  );

  it.effect("round-trips put then get", () =>
    Effect.gen(function* () {
      const repository = yield* PalliumCommandCacheRepository;

      yield* repository.put(baseEntry);
      const found = yield* repository.get(getInput);

      const entry = Option.getOrNull(found);
      assert.ok(entry, "Expected a cache hit after put.");
      assert.strictEqual(entry?.command, baseEntry.command);
      assert.strictEqual(entry?.indexEpoch, baseEntry.indexEpoch);
      assert.deepStrictEqual(entry?.argsJson, baseEntry.argsJson);
      assert.deepStrictEqual(entry?.resultJson, baseEntry.resultJson);
    }),
  );

  it.effect("upserts the same key in place", () =>
    Effect.gen(function* () {
      const repository = yield* PalliumCommandCacheRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.put(baseEntry);
      yield* repository.put({
        ...baseEntry,
        resultJson: { index_status: "stale", embedding_backlog: 7 },
        expiresAt: "2026-06-24T12:00:00.000Z",
      });

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM pallium_command_cache
        WHERE command = ${baseEntry.command}
          AND args = ${baseEntry.args}
          AND project_id = ${projectId}
          AND index_epoch = ${baseEntry.indexEpoch}
      `;
      assert.strictEqual(rows[0]?.count, 1);

      const entry = Option.getOrNull(yield* repository.get(getInput));
      assert.deepStrictEqual(entry?.resultJson, {
        index_status: "stale",
        embedding_backlog: 7,
      });
    }),
  );

  it.effect("misses old keys after an index_epoch change", () =>
    Effect.gen(function* () {
      const repository = yield* PalliumCommandCacheRepository;

      yield* repository.put(baseEntry);

      // A new epoch means the same command/args/project key no longer matches.
      const missed = yield* repository.get({ ...getInput, indexEpoch: "epoch-2" });
      assert.strictEqual(Option.isNone(missed), true);

      // The old epoch row is still readable until invalidated.
      const stillThere = yield* repository.get(getInput);
      assert.strictEqual(Option.isSome(stillThere), true);
    }),
  );

  it.effect("invalidateStaleEpochs drops every other epoch for the project", () =>
    Effect.gen(function* () {
      const repository = yield* PalliumCommandCacheRepository;

      yield* repository.put(baseEntry);
      yield* repository.put({ ...baseEntry, indexEpoch: "epoch-2" });
      yield* repository.put({ ...baseEntry, indexEpoch: "epoch-3" });

      yield* repository.invalidateStaleEpochs({
        projectId,
        currentIndexEpoch: "epoch-3",
      });

      const oldEpoch = yield* repository.get(getInput);
      const currentEpoch = yield* repository.get({ ...getInput, indexEpoch: "epoch-3" });
      assert.strictEqual(Option.isNone(oldEpoch), true);
      assert.strictEqual(Option.isSome(currentEpoch), true);
    }),
  );

  it.effect("sweepExpired drops expired rows", () =>
    Effect.gen(function* () {
      const repository = yield* PalliumCommandCacheRepository;

      // The in-memory DB is shared across tests in this block, so scope this
      // case to its own project to avoid counting rows other tests inserted.
      const sweepProjectId = ProjectId.makeUnsafe("project-sweep");
      yield* repository.put({
        ...baseEntry,
        projectId: sweepProjectId,
        indexEpoch: "epoch-expired",
        expiresAt: "2026-06-24T10:00:00.000Z",
      });
      yield* repository.put({
        ...baseEntry,
        projectId: sweepProjectId,
        indexEpoch: "epoch-fresh",
        expiresAt: "2026-06-24T23:00:00.000Z",
      });

      yield* repository.sweepExpired({ now: "2026-06-24T10:30:00.000Z" });

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly indexEpoch: string }>`
        SELECT index_epoch AS "indexEpoch"
        FROM pallium_command_cache
        WHERE project_id = ${sweepProjectId}
        ORDER BY index_epoch ASC
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.indexEpoch),
        ["epoch-fresh"],
      );
    }),
  );
});
