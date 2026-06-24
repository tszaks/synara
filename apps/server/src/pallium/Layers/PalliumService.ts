import {
  PalliumChangedNowResult,
  PalliumDecisionList,
  PalliumDoctorResult,
  PalliumEmbedResult,
  PalliumIndexResult,
  PalliumSessionList,
  PalliumSessionSearchList,
  PalliumSessionSemanticList,
  type PalliumStatus,
  PalliumVersionResult,
} from "@t3tools/contracts";
import { Effect, Layer, Ref } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PalliumServiceError, PalliumUnavailableError } from "../Errors.ts";
import { DEFAULT_PALLIUM_BINARY, type PalliumSpawn, runPalliumJson } from "../palliumCli.ts";
import { redactedErrorMessage } from "../redactSecrets.ts";
import { PalliumService, type PalliumServiceShape } from "../Services/PalliumService.ts";

// The secret-store key the embedding api key is written under (see wsRpc's memorySetEmbeddingApiKey
// handler). Kept in sync with that constant; the key is read here ONLY to put it into the child env.
const MEMORY_EMBEDDING_API_KEY_SECRET = "memory-embedding-api-key";

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
      const secretStore = yield* ServerSecretStore;
      const statusCacheRef = yield* Ref.make<StatusCacheEntry | null>(null);
      const ttlMs = options?.statusCacheTtlMs ?? STATUS_CACHE_TTL_MS;

      // Resolve the binary path from the Memory settings block, falling back to "pallium" (resolved
      // on PATH) for an empty/missing value. Failure to read settings must never break the
      // handshake, which is contractually `Effect<…, never>`.
      const readBinaryPath = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.memory.binaryPath.trim() || DEFAULT_PALLIUM_BINARY),
        Effect.catchCause(() => Effect.succeed(DEFAULT_PALLIUM_BINARY)),
      );

      // Build the PALLIUM_EMBED_* env map from settings.memory.embedding + the secret-store api key.
      // This is the ONLY place the embedding api key is read, and it goes ONLY into the child env
      // (never logged, never put on a contract). Empty/missing values are omitted so the Pallium
      // child falls back to its own defaults rather than receiving blank env vars. A failure to read
      // settings or the secret must never break the embedding commands; it degrades to no extra env.
      const readEmbeddingEnv = Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const embedding = settings.memory.embedding;
        const apiKeyBytes = yield* secretStore.get(MEMORY_EMBEDDING_API_KEY_SECRET);
        const apiKey = apiKeyBytes ? new TextDecoder().decode(apiKeyBytes).trim() : "";
        const env: NodeJS.ProcessEnv = {};
        const provider = embedding.provider.trim();
        const baseUrl = embedding.baseUrl.trim();
        const model = embedding.model.trim();
        if (provider.length > 0) {
          env.PALLIUM_EMBED_PROVIDER = provider;
        }
        if (baseUrl.length > 0) {
          env.PALLIUM_EMBED_BASE_URL = baseUrl;
        }
        if (model.length > 0) {
          env.PALLIUM_EMBED_MODEL = model;
        }
        if (apiKey.length > 0) {
          env.PALLIUM_EMBED_API_KEY = apiKey;
        }
        return { env, model };
      }).pipe(Effect.catchCause(() => Effect.succeed({ env: {} as NodeJS.ProcessEnv, model: "" })));

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

      // `index` rebuilds the repo's index (MUTATING). The repo path is passed as a discrete positional
      // arg (never interpolated). It can be the slowest command, so it uses runPalliumJson's default
      // timeout rather than the short HANDSHAKE_TIMEOUT_MS.
      const index = (input: { readonly cwd: string }) =>
        readBinaryPath.pipe(
          Effect.flatMap((binaryPath) =>
            runPalliumJson({
              subcommand: "index",
              schema: PalliumIndexResult,
              binaryPath,
              args: [input.cwd],
              cwd: input.cwd,
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

      // `sessions search` takes the query as positional argv after the `search` subcommand, with an
      // optional `--limit N`. The query is passed as a discrete arg (never interpolated) so it is
      // never treated as a shell string. This uses the default (non-hybrid) lexical search — no
      // `--hybrid` flag — so it needs NO embeddings.
      const sessionsSearch = (input: { readonly query: string; readonly limit?: number }) =>
        readBinaryPath.pipe(
          Effect.flatMap((binaryPath) =>
            runPalliumJson({
              subcommand: "sessions",
              schema: PalliumSessionSearchList,
              binaryPath,
              args:
                input.limit !== undefined
                  ? ["search", input.query, "--limit", String(input.limit)]
                  : ["search", input.query],
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

      // `sessions semantic` runs vector search. The query is positional after `semantic`; an optional
      // `--limit N` and `--model <model>` (from settings) follow. The embedding config + api key are
      // passed via the child env (PALLIUM_EMBED_*), never as logged flags. The api key never appears
      // in argv. Vectors are partitioned by (provider, model) so a result only comes from the space
      // the query was run against.
      const sessionsSemantic = (input: { readonly query: string; readonly limit?: number }) =>
        Effect.gen(function* () {
          const binaryPath = yield* readBinaryPath;
          const { env, model } = yield* readEmbeddingEnv;
          const args = ["semantic", input.query];
          if (input.limit !== undefined) {
            args.push("--limit", String(input.limit));
          }
          if (model.length > 0) {
            args.push("--model", model);
          }
          return yield* runPalliumJson({
            subcommand: "sessions",
            schema: PalliumSessionSemanticList,
            binaryPath,
            args,
            ...(Object.keys(env).length > 0 ? { env } : {}),
            ...(options?.spawn ? { spawn: options.spawn } : {}),
            ...(options?.platform ? { platform: options.platform } : {}),
          });
        });

      // `sessions embed` embeds the backlog (MUTATING). An optional `--model <model>` (from settings)
      // selects the target space; the embedding config + api key are passed via the child env
      // (PALLIUM_EMBED_*), exactly like `sessionsSemantic`.
      const sessionsEmbed = () =>
        Effect.gen(function* () {
          const binaryPath = yield* readBinaryPath;
          const { env, model } = yield* readEmbeddingEnv;
          const args = ["embed"];
          if (model.length > 0) {
            args.push("--model", model);
          }
          return yield* runPalliumJson({
            subcommand: "sessions",
            schema: PalliumEmbedResult,
            binaryPath,
            args,
            ...(Object.keys(env).length > 0 ? { env } : {}),
            ...(options?.spawn ? { spawn: options.spawn } : {}),
            ...(options?.platform ? { platform: options.platform } : {}),
          });
        });

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
        index,
        changedNow,
        sessionsList,
        sessionsSearch,
        sessionsSemantic,
        sessionsEmbed,
        decisions,
      } satisfies PalliumServiceShape;
    }),
  );

export const PalliumServiceLive = makePalliumServiceLive();
