// FILE: PalliumService.test.ts
// Purpose: Verifies the Pallium binary boundary — graceful absence on ENOENT, version/doctor
//          happy-path decode, allowlist rejection, and secret redaction from stderr.
// Layer: Pallium service test
// Depends on: makePalliumServiceLive with an injected fake spawn + ServerSettingsService.layerTest.

import { EventEmitter } from "node:events";

import { assert, it } from "@effect/vitest";
import { PalliumVersionResult } from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { PalliumServiceError } from "./Errors.ts";
import { makePalliumServiceLive } from "./Layers/PalliumService.ts";
import { PalliumService } from "./Services/PalliumService.ts";
import {
  type PalliumReadable,
  type PalliumSpawn,
  type PalliumSpawnedProcess,
  runPalliumJson,
} from "./palliumCli.ts";

// A fake child process whose stdout/stderr/close/error are driven on a microtask so listeners
// attached synchronously after spawn still fire. Only the surface the boundary touches is modeled.
class FakeStream extends EventEmitter implements PalliumReadable {}

class FakeChild extends EventEmitter implements PalliumSpawnedProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

// Extract the failure value from a failed Exit, or fail the test.
function expectFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) {
    assert.fail("expected a failure");
  }
  return Cause.squash(exit.cause);
}

interface FakeRun {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number | null;
  readonly enoent?: boolean;
}

function makeFakeSpawn(run: FakeRun): PalliumSpawn {
  return () => {
    const child = new FakeChild();
    queueMicrotask(() => {
      if (run.enoent) {
        const error = new Error("spawn pallium ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        child.emit("error", error);
        return;
      }
      if (run.stdout) {
        child.stdout.emit("data", Buffer.from(run.stdout));
      }
      if (run.stderr) {
        child.stderr.emit("data", Buffer.from(run.stderr));
      }
      child.emit("close", run.code ?? 0, null);
    });
    return child;
  };
}

const VERSION_JSON = JSON.stringify({
  module: "github.com/example/pallium",
  version: "1.2.3",
  go_version: "go1.22",
});

const DOCTOR_JSON = JSON.stringify({
  repo_root: "/repo",
  repo_db_path: "/repo/.pallium/pallium.sqlite",
  repo_db_exists: true,
  index_status: "indexed",
  working_tree_dirty: false,
  working_tree_file_count: 0,
  session_db_path: "/home/.pallium/sessions.sqlite",
  session_db_exists: true,
  session_stats: {
    sessions: 1,
    events: 2,
    messages: 3,
    chunks: 4,
    embeddings: 5,
  },
  embedding_model: "text-embedding-3-small",
  embedding_backlog: 0,
  openai_key_available: true,
});

function layerWith(run: FakeRun) {
  return makePalliumServiceLive({ spawn: makeFakeSpawn(run), platform: "linux" }).pipe(
    Layer.provide(ServerSettingsService.layerTest()),
  );
}

it.effect("status returns available:false when the binary is absent (ENOENT)", () =>
  Effect.gen(function* () {
    const pallium = yield* PalliumService;
    const status = yield* pallium.status;
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.capabilities.indexed, false);
    assert.strictEqual(status.capabilities.embeddings, false);
    assert.strictEqual(status.capabilities.openaiKeyAvailable, false);
    assert.isString(status.checkedAt);
  }).pipe(Effect.provide(layerWith({ enoent: true }))),
);

it.effect("version decodes the happy-path --json output", () =>
  Effect.gen(function* () {
    const pallium = yield* PalliumService;
    const version = yield* pallium.version;
    assert.strictEqual(version.version, "1.2.3");
    assert.strictEqual(version.module, "github.com/example/pallium");
  }).pipe(Effect.provide(layerWith({ stdout: VERSION_JSON }))),
);

it.effect("doctor decodes the happy-path --json output", () =>
  Effect.gen(function* () {
    const pallium = yield* PalliumService;
    const doctor = yield* pallium.doctor({ cwd: "/repo" });
    assert.strictEqual(doctor.index_status, "indexed");
    assert.strictEqual(doctor.session_stats.embeddings, 5);
    assert.strictEqual(doctor.openai_key_available, true);
  }).pipe(Effect.provide(layerWith({ stdout: DOCTOR_JSON }))),
);

it.effect("status maps version + doctor into available:true capabilities", () =>
  Effect.gen(function* () {
    const pallium = yield* PalliumService;
    // version is probed first, then doctor; the fake spawn returns whichever stdout we give it for
    // every call. Give doctor's payload so the capability mapping has data; version decode is
    // lenient enough to accept it via the partial fields, so map only via the available branch.
    const status = yield* pallium.status;
    assert.strictEqual(status.available, true);
  }).pipe(
    Effect.provide(
      // version call needs version JSON, doctor call needs doctor JSON. Use a spawn that returns
      // the right payload per subcommand by inspecting argv.
      makePalliumServiceLive({
        spawn: ((command, args) => {
          const child = new FakeChild();
          const isVersion = args[0] === "version";
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from(isVersion ? VERSION_JSON : DOCTOR_JSON));
            child.emit("close", 0, null);
          });
          return child;
        }) satisfies PalliumSpawn,
        platform: "linux",
      }).pipe(Layer.provide(ServerSettingsService.layerTest())),
    ),
  ),
);

it.effect("runPalliumJson rejects a subcommand outside the allowlist", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      runPalliumJson({
        // Force an off-allowlist subcommand to prove the guard rejects before spawning.
        subcommand: "rm-rf" as never,
        schema: PalliumVersionResult,
        spawn: makeFakeSpawn({ stdout: VERSION_JSON }),
        platform: "linux",
      }),
    );
    const error = expectFailure(exit);
    assert.instanceOf(error, PalliumServiceError);
    assert.match((error as PalliumServiceError).message, /not allowed/);
  }),
);

it.effect("strips a fake sk- token from stderr on a non-zero exit", () =>
  Effect.gen(function* () {
    const secret = "sk-ABCDEF1234567890SECRET";
    const exit = yield* Effect.exit(
      runPalliumJson({
        subcommand: "version",
        schema: Schema.Unknown,
        spawn: makeFakeSpawn({
          stderr: `boom failed with key ${secret}`,
          code: 1,
        }),
        platform: "linux",
      }),
    );
    const error = expectFailure(exit);
    assert.instanceOf(error, PalliumServiceError);
    const message = (error as PalliumServiceError).message;
    assert.notInclude(message, secret);
    assert.include(message, "[redacted]");
  }),
);
