import {
  PalliumChangedNowResult,
  PalliumDecisionList,
  PalliumDoctorResult,
  PalliumSessionList,
  type PalliumStatus,
  PalliumVersionResult,
} from "@t3tools/contracts";
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

      // Resolve the binary path from the Memory settings block, falling back to "pallium" (resolved
      // on PATH) for an empty/missing value. Failure to read settings must never break the
      // handshake, which is contractually `Effect<…, never>`.
      const readBinaryPath = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.memory.binaryPath.trim() || DEFAULT_PALLIUM_BINARY),
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

      // Read commands that hit the repo/session DB. They can take longer than the handshake probes,
      // so they use runPalliumJson's default timeout rather than the short HANDSHAKE_TIMEOUT_MS.
      const changedNow = (input: { readonly cwd: string }) =>
        readBinaryPath.pipe(
          Effect.flatMap((binaryPath) =>
            runPalliumJson({
              subcommand: "changed-now",
              schema: PalliumChangedNowResult,
              binaryPath,
              args: [input.cwd],
              cwd: input.cwd,
              ...(options?.spawn ? { spawn: options.spawn } : {}),
              ...(options?.platform ? { platform: options.platform } : {}),
            }),
          ),
        );

      const sessionsList = (input?: { readonly limit?: number }) =>
        readBinaryPath.pipe(
          Effect.flatMap((binaryPath) =>
            runPalliumJson({
              subcommand: "sessions",
              schema: PalliumSessionList,
              binaryPath,
              args:
                input?.limit !== undefined ? ["list", "--limit", String(input.limit)] : ["list"],
              ...(options?.spawn ? { spawn: options.spawn } : {}),
              ...(options?.platform ? { platform: options.platform } : {}),
            }),
          ),
        );

      // `decisions` takes the query as the FIRST positional arg, then an optional repo path; both are
      // passed as discrete argv (never interpolated) so a query is never treated as a shell string.
      const decisions = (input: { readonly query: string; readonly cwd?: string }) =>
        readBinaryPath.pipe(
          Effect.flatMap((binaryPath) =>
            runPalliumJson({
              subcommand: "decisions",
              schema: PalliumDecisionList,
              binaryPath,
              args: input.cwd !== undefined ? [input.query, input.cwd] : [input.query],
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
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
        changedNow,
        sessionsList,
        decisions,
      } satisfies PalliumServiceShape;
    }),
  );

export const PalliumServiceLive = makePalliumServiceLive();
