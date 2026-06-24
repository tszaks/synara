import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerSecretStore, type SecretStoreError } from "../Services/ServerSecretStore";
import { ServerSecretStoreLive } from "./ServerSecretStore";

// Matches the wsRpc `memory.setEmbeddingApiKey` handler key.
const MEMORY_EMBEDDING_API_KEY_SECRET = "memory-embedding-api-key";

const makeLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "dpcode-secret-store-test-",
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

// Exposes ServerConfig + FileSystem alongside the secret store so a test can inspect on-disk paths.
const makeLayerWithConfig = () =>
  ServerSecretStoreLive.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "dpcode-secret-store-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const runWithSecretStore = (effect: Effect.Effect<void, SecretStoreError, ServerSecretStore>) =>
  effect.pipe(Effect.provide(makeLayer()), Effect.scoped, Effect.runPromise);

describe("ServerSecretStoreLive", () => {
  it("persists and reads named secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("session-signing", new Uint8Array([1, 2, 3]));

        expect(Array.from((yield* store.get("session-signing")) ?? [])).toEqual([1, 2, 3]);
      }),
    );
  });

  it("reuses generated random secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        const first = yield* store.getOrCreateRandom("websocket", 32);
        const second = yield* store.getOrCreateRandom("websocket", 32);

        expect(first.byteLength).toBe(32);
        expect(Array.from(second)).toEqual(Array.from(first));
      }),
    );
  });

  it("removes secrets idempotently", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("remove-me", new Uint8Array([9]));
        yield* store.remove("remove-me");
        yield* store.remove("remove-me");

        expect(yield* store.get("remove-me")).toBeNull();
      }),
    );
  });

  // Mirrors the wsRpc `memory.setEmbeddingApiKey` handler: the embedding API key is a credential,
  // so it is written to the 0700 secret store (never settings.json), and an empty key clears it.
  it("stores the memory embedding API key in the secrets dir, not settings.json", async () => {
    const result = await Effect.gen(function* () {
      const store = yield* ServerSecretStore;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;

      // Write path: encode the key to bytes under the memory secret name.
      yield* store.set(MEMORY_EMBEDDING_API_KEY_SECRET, new TextEncoder().encode("sk-secret-123"));
      const stored = yield* store.get(MEMORY_EMBEDDING_API_KEY_SECRET);

      // The secret lives under secretsDir, which is separate from settingsPath.
      const secretsDirEntries = yield* fs.readDirectory(config.secretsDir);

      // Clear path: an empty key removes the stored secret.
      yield* store.remove(MEMORY_EMBEDDING_API_KEY_SECRET);
      const afterClear = yield* store.get(MEMORY_EMBEDDING_API_KEY_SECRET);

      return {
        roundTripped: stored ? new TextDecoder().decode(stored) : null,
        secretsDirEntries,
        secretsDir: config.secretsDir,
        settingsPath: config.settingsPath,
        afterClear,
      };
    }).pipe(Effect.provide(makeLayerWithConfig()), Effect.scoped, Effect.runPromise);

    expect(result.roundTripped).toBe("sk-secret-123");
    // The secret file is under secretsDir, which is not the settings.json path.
    expect(result.secretsDirEntries.some((name) => name.includes("memory-embedding-api-key"))).toBe(
      true,
    );
    expect(result.settingsPath.startsWith(result.secretsDir)).toBe(false);
    expect(result.afterClear).toBeNull();
  });
});
