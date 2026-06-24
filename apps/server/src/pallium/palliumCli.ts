/**
 * The Pallium binary boundary.
 *
 * `runPalliumJson` is the ONLY place Synara spawns the `pallium` Go binary. It always runs a
 * single allowlisted subcommand with `--json`, passes discrete argv (never an interpolated command
 * string), enforces an output ceiling + timeout, redacts secrets from stdout AND stderr before any
 * of it is logged or surfaced, and decodes stdout against a PR1 contract schema.
 *
 * A missing binary (ENOENT) is reported as `unavailable`, never a crash, so the caller can fold it
 * into a graceful `available: false` status.
 */
import { spawn as nodeSpawn } from "node:child_process";

import { prepareWindowsSafeProcess } from "@t3tools/shared/windowsProcess";
import { Effect, Schema } from "effect";

import { PalliumServiceError, PalliumUnavailableError } from "./Errors.ts";
import { redactSecrets, redactedErrorMessage } from "./redactSecrets.ts";

/**
 * Real Pallium subcommands only. There is intentionally no `refresh` (it does not exist; refresh =
 * re-run `index`). User input is never interpolated into a command string; the subcommand must be
 * one of these literals and every other token is passed as discrete argv.
 */
export const PALLIUM_SUBCOMMANDS = [
  "version",
  "doctor",
  "index",
  "explain",
  "risk",
  "safe",
  "plan",
  "neighbors",
  "decisions",
  "changed-now",
  "handoff",
  "review",
  "verify",
  "task",
  "sessions",
] as const;

export type PalliumSubcommand = (typeof PALLIUM_SUBCOMMANDS)[number];

const PALLIUM_SUBCOMMAND_SET: ReadonlySet<string> = new Set(PALLIUM_SUBCOMMANDS);

export const DEFAULT_PALLIUM_BINARY = "pallium";
const DEFAULT_TIMEOUT_MS = 30_000;
// Bound the buffered stdout/stderr so a runaway binary can't exhaust memory.
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
// If SIGTERM doesn't drop the child quickly (on timeout/abort/overflow), escalate to SIGKILL so we
// never leave an orphaned/zombie pallium process holding the repo DB.
const KILL_ESCALATION_MS = 2_000;

/**
 * Minimal structural type of `node:child_process` spawn we depend on. Declaring only the surface
 * we use (data events) lets tests inject a fake spawn (e.g. to simulate ENOENT) without fully
 * re-implementing `NodeJS.ReadableStream`.
 */
export interface PalliumReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface PalliumSpawnedProcess {
  readonly stdout: PalliumReadable | null;
  readonly stderr: PalliumReadable | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type PalliumSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly stdio: ["ignore", "pipe", "pipe"];
    // Always false: we never hand a command string to a shell on any platform. Windows `.cmd`/`.bat`
    // shims are resolved + escaped explicitly via `prepareWindowsSafeProcess` instead, matching the
    // codex spawn path. `shell: true` would re-open a command-string injection surface on Windows.
    readonly shell: false;
    readonly windowsHide?: true;
    // The child's environment. When the caller passes an `env` map, it is merged OVER process.env so
    // the parent's PATH/HOME/etc. survive and only the caller's keys (e.g. PALLIUM_EMBED_*) are
    // added/overridden. A secret carried here (the embedding api key) goes ONLY into the child env;
    // it is never logged, and redactSecrets covers anything the child echoes back.
    readonly env?: NodeJS.ProcessEnv;
  },
) => PalliumSpawnedProcess;

export interface RunPalliumJsonInput<A, I> {
  readonly subcommand: PalliumSubcommand;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Schema the parsed stdout JSON is decoded against (a PR1 Pallium output contract). */
  readonly schema: Schema.Codec<A, I>;
  /** Resolved binary path; defaults to the Memory `binaryPath` setting or "pallium". */
  readonly binaryPath?: string;
  /**
   * Extra environment variables for the child, merged OVER process.env (so PATH/HOME survive). Used
   * to pass the embedding config (PALLIUM_EMBED_PROVIDER/_BASE_URL/_MODEL/_API_KEY) to the binary.
   * A secret carried here goes only into the child env; it is never logged.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: defaults to `node:child_process` spawn. */
  readonly spawn?: PalliumSpawn;
  /** Test seam: defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

interface PalliumRawResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function collectStream(stream: PalliumReadable | null, chunks: Buffer[]): void {
  if (!stream) {
    return;
  }
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
}

/** Spawn the binary and resolve once it closes, surfacing ENOENT as PalliumUnavailableError. */
function spawnPallium(input: {
  readonly binaryPath: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn: PalliumSpawn;
  readonly platform: NodeJS.Platform;
}): Effect.Effect<PalliumRawResult, PalliumServiceError | PalliumUnavailableError> {
  return Effect.callback<PalliumRawResult, PalliumServiceError | PalliumUnavailableError>(
    (resume) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      let child: PalliumSpawnedProcess;
      try {
        // Resolve the binary (and wrap any Windows `.cmd`/`.bat` shim) without ever using
        // `shell: true`. On Windows this routes batch shims through `cmd.exe /c` with every token
        // caret-escaped + quoted; on POSIX it is a pass-through. This is the same injection-safe
        // path codexAppServerManager uses. argv is always passed discretely, never interpolated.
        const prepared = prepareWindowsSafeProcess(input.binaryPath, input.argv, {
          platform: input.platform,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        });
        child = input.spawn(prepared.command, prepared.args, {
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          // Merge the caller's env OVER process.env so PATH/HOME/etc. survive and only the caller's
          // keys (e.g. the embedding config + api key) are added. Omit entirely when no extra env is
          // passed so the child simply inherits the parent's environment.
          ...(input.env !== undefined ? { env: { ...process.env, ...input.env } } : {}),
          ...(prepared.windowsHide ? { windowsHide: prepared.windowsHide } : {}),
        });
      } catch (cause) {
        resume(
          Effect.fail(new PalliumServiceError({ message: redactedErrorMessage(cause), cause })),
        );
        return;
      }

      // Ask the child to exit, then force-kill if it ignores SIGTERM, so an unresponsive pallium
      // process is never left orphaned holding the repo DB. The escalation timer is unref'd so it
      // can't keep the event loop alive on its own.
      const terminateChild = () => {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_ESCALATION_MS);
        if (typeof killTimer.unref === "function") {
          killTimer.unref();
        }
      };

      const settle = (
        effect: Effect.Effect<PalliumRawResult, PalliumServiceError | PalliumUnavailableError>,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (input.signal) {
          input.signal.removeEventListener("abort", onAbort);
        }
        resume(effect);
      };

      const onAbort = () => {
        terminateChild();
        settle(Effect.fail(new PalliumServiceError({ message: "pallium command aborted" })));
      };

      const timer = setTimeout(() => {
        terminateChild();
        settle(
          Effect.fail(
            new PalliumServiceError({
              message: `pallium command timed out after ${input.timeoutMs}ms`,
            }),
          ),
        );
      }, input.timeoutMs);
      // Don't let a stuck pallium probe keep the event loop alive.
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      if (input.signal) {
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      collectStream(child.stdout, stdoutChunks);
      collectStream(child.stderr, stderrChunks);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > DEFAULT_MAX_BUFFER_BYTES) {
          terminateChild();
          settle(
            Effect.fail(new PalliumServiceError({ message: "pallium stdout exceeded max buffer" })),
          );
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > DEFAULT_MAX_BUFFER_BYTES) {
          terminateChild();
          settle(
            Effect.fail(new PalliumServiceError({ message: "pallium stderr exceeded max buffer" })),
          );
        }
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        // ENOENT == binary missing/not on PATH. Surface as unavailable, never a crash.
        if (error.code === "ENOENT") {
          settle(
            Effect.fail(
              new PalliumUnavailableError({
                message: redactSecrets(`pallium binary not found: ${input.binaryPath}`),
                cause: error,
              }),
            ),
          );
          return;
        }
        settle(
          Effect.fail(
            new PalliumServiceError({ message: redactedErrorMessage(error), cause: error }),
          ),
        );
      });

      child.on("close", (code: number | null) => {
        settle(
          Effect.succeed({
            code,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          }),
        );
      });
    },
  );
}

/**
 * Run an allowlisted Pallium subcommand with `--json` and decode its stdout against `schema`.
 *
 * Failure modes:
 * - Unknown subcommand -> PalliumServiceError (rejected before any spawn).
 * - Binary missing (ENOENT) -> PalliumUnavailableError.
 * - Non-zero exit / parse / decode / timeout -> PalliumServiceError (redacted).
 */
export function runPalliumJson<A, I>(
  input: RunPalliumJsonInput<A, I>,
): Effect.Effect<A, PalliumServiceError | PalliumUnavailableError> {
  if (!PALLIUM_SUBCOMMAND_SET.has(input.subcommand)) {
    return Effect.fail(
      new PalliumServiceError({
        message: `pallium subcommand not allowed: ${input.subcommand}`,
      }),
    );
  }

  const binaryPath = input.binaryPath ?? DEFAULT_PALLIUM_BINARY;
  const argv = [input.subcommand, ...(input.args ?? []), "--json"];
  const spawn = input.spawn ?? (nodeSpawn as unknown as PalliumSpawn);
  const platform = input.platform ?? process.platform;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return spawnPallium({
    binaryPath,
    argv,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    timeoutMs,
    spawn,
    platform,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0) {
        const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
        return Effect.fail(
          new PalliumServiceError({
            message: `pallium ${input.subcommand} exited with code ${result.code ?? "unknown"}${
              detail ? `: ${detail}` : ""
            }`,
          }),
        );
      }
      return Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        // The raw SyntaxError message can echo a slice of stdout (possibly a secret), so carry a
        // redacted string as the cause rather than the raw error object.
        catch: (cause) =>
          new PalliumServiceError({
            message: `pallium ${input.subcommand} returned invalid JSON: ${redactedErrorMessage(cause)}`,
            cause: redactedErrorMessage(cause),
          }),
      }).pipe(
        Effect.flatMap((parsed) =>
          Schema.decodeUnknownEffect(input.schema)(parsed).pipe(
            // A ParseError stringifies the offending input value, which could contain a secret the
            // binary echoed. Never carry the raw ParseError; redact it to a safe string.
            Effect.mapError(
              (cause) =>
                new PalliumServiceError({
                  message: `pallium ${input.subcommand} JSON did not match the expected schema`,
                  cause: redactedErrorMessage(cause),
                }),
            ),
          ),
        ),
      );
    }),
  );
}
