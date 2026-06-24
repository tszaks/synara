import { PalliumDoctorResult, type PalliumStatus, PalliumVersionResult } from "@t3tools/contracts";
import { Effect, Layer, Ref } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { PalliumServiceError, PalliumUnavailableError } from "../Errors.ts";
import { DEFAULT_PALLIUM_BINARY, type PalliumSpawn, runPalliumJson } from "../palliumCli.ts";
import { redactedErrorMessage } from "../redactSecrets.ts";
import { PalliumService, type PalliumServiceShape } from "../Services/PalliumService.ts";

// The handshake is two cheap calls (version + doctor). Memoize it so we don't re-spawn the binary
// on every status read; the TTL is short so an install/upgrade is reflected promptly.
const STATUS_CACHE_TTL_MS = 30_000;
// Cheap probes: a present binary answers version/doctor in well under a second.
const HANDSHAKE_TIMEOUT_MS = 5_000;

const ALL_CAPABILITIES_FALSE = {
  indexed: false,
  embeddings: false,
  openaiKeyAvailable: false,
} as const;

interface StatusCacheEntry {
  readonly expiresAt: number;
  readonly status: PalliumStatus;
}

export interface PalliumServiceLiveOptions {
  /** Test seam forwarded to `runPalliumJson`. Defaults to `node:child_process` spawn. */
  readonly spawn?: PalliumSpawn;
  readonly platform?: NodeJS.Platform;
  readonly statusCacheTtlMs?: number;
}

export const makePalliumServiceLive = (options?: PalliumServiceLiveOptions) =>
  Layer.effect(
    PalliumService,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const statusCacheRef = yield* Ref.make<StatusCacheEntry | null>(null);
      const ttlMs = options?.statusCacheTtlMs ?? STATUS_CACHE_TTL_MS;

      // TODO(PR4): read `settings.memory.binaryPath` once the Memory settings block exists. Until
      // then the binary path defaults to "pallium" (resolved on PATH).
      const resolveBinaryPath = Effect.sync(() => DEFAULT_PALLIUM_BINARY).pipe(
        Effect.catchCause(() => Effect.succeed(DEFAULT_PALLIUM_BINARY)),
      );
      // Touch serverSettings so the dependency is real and ready for PR4 to use; failure to read
      // settings must never break the handshake.
      const readBinaryPath = serverSettings.getSettings.pipe(
        Effect.flatMap(() => resolveBinaryPath),
        Effect.catchCause(() => Effect.succeed(DEFAULT_PALLIUM_BINARY)),
      );

      const version = readBinaryPath.pipe(
        Effect.flatMap((binaryPath) =>
          runPalliumJson({
            subcommand: "version",
            schema: PalliumVersionResult,
            binaryPath,
            timeoutMs: HANDSHAKE_TIMEOUT_MS,
            ...(options?.spawn ? { spawn: options.spawn } : {}),
            ...(options?.platform ? { platform: options.platform } : {}),
          }),
        ),
      );

      const doctor = (input?: { readonly cwd?: string }) =>
        readBinaryPath.pipe(
          Effect.flatMap((binaryPath) =>
            runPalliumJson({
              subcommand: "doctor",
              schema: PalliumDoctorResult,
              binaryPath,
              timeoutMs: HANDSHAKE_TIMEOUT_MS,
              ...(input?.cwd !== undefined ? { args: [input.cwd] } : {}),
              ...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
              ...(options?.spawn ? { spawn: options.spawn } : {}),
              ...(options?.platform ? { platform: options.platform } : {}),
            }),
          ),
        );

      const buildAvailableStatus = (input: {
        readonly binaryPath: string;
        readonly version: string;
        readonly doctor: PalliumDoctorResult | null;
      }): PalliumStatus => ({
        available: true,
        binaryPath: input.binaryPath,
        version: input.version,
        capabilities: {
          indexed: input.doctor?.index_status === "indexed",
          embeddings: (input.doctor?.session_stats.embeddings ?? 0) > 0,
          openaiKeyAvailable: input.doctor?.openai_key_available ?? false,
        },
        checkedAt: new Date().toISOString(),
      });

      const buildUnavailableStatus = (reason: string): PalliumStatus => ({
        available: false,
        capabilities: { ...ALL_CAPABILITIES_FALSE },
        checkedAt: new Date().toISOString(),
        reason,
      });

      // The capability handshake. Folds every failure (absent binary, decode failure, timeout)
      // into a valid `available: false` status; it can never fail.
      const computeStatus: Effect.Effect<PalliumStatus, never> = readBinaryPath.pipe(
        Effect.flatMap((binaryPath) =>
          version.pipe(
            Effect.flatMap((versionResult) =>
              // doctor needs a repo path; with none provided it may report no repo. Treat any
              // doctor failure as "available but capabilities unknown" rather than unavailable,
              // since version already proved the binary works.
              doctor().pipe(
                Effect.map((doctorResult) =>
                  buildAvailableStatus({
                    binaryPath,
                    version: versionResult.version,
                    doctor: doctorResult,
                  }),
                ),
                Effect.catchCause(() =>
                  Effect.succeed(
                    buildAvailableStatus({
                      binaryPath,
                      version: versionResult.version,
                      doctor: null,
                    }),
                  ),
                ),
              ),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                buildUnavailableStatus(
                  error instanceof PalliumUnavailableError || error instanceof PalliumServiceError
                    ? error.message
                    : redactedErrorMessage(error),
                ),
              ),
            ),
          ),
        ),
      );

      const status: Effect.Effect<PalliumStatus, never> = Effect.gen(function* () {
        const now = Date.now();
        const cached = yield* Ref.get(statusCacheRef);
        if (cached && cached.expiresAt > now) {
          return cached.status;
        }
        const fresh = yield* computeStatus;
        yield* Ref.set(statusCacheRef, { expiresAt: now + ttlMs, status: fresh });
        return fresh;
      });

      return {
        status,
        version,
        doctor,
      } satisfies PalliumServiceShape;
    }),
  );

export const PalliumServiceLive = makePalliumServiceLive();
