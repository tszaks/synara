import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { MemoryServerSettings, ServerSettings, ServerSettingsPatch } from "./settings";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

// A legacy settings.json written before the Memory feature existed: no `memory` block at all.
it.effect("decodes a legacy settings.json with no memory block and fills memory defaults", () =>
  Effect.gen(function* () {
    const legacy = {
      enableAssistantStreaming: true,
      providers: {
        codex: { binaryPath: "/usr/local/bin/codex" },
      },
    };

    const parsed = yield* decode(ServerSettings, legacy);

    assert.strictEqual(parsed.memory.enabled, false);
    assert.strictEqual(parsed.memory.binaryPath, "pallium");
    assert.strictEqual(parsed.memory.embedding.provider, "ollama");
    assert.strictEqual(parsed.memory.embedding.baseUrl, "");
    assert.strictEqual(parsed.memory.embedding.model, "nomic-embed-text");
    assert.strictEqual(parsed.memory.indexingCadence, 15);
    assert.strictEqual(parsed.memory.storageBudgetMb, 512);
  }),
);

// A partial memory block decodes its present keys and fills the rest from defaults.
it.effect("decodes a partial memory block and round-trips the present fields", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(MemoryServerSettings, {
      enabled: true,
      binaryPath: "/opt/pallium",
      embedding: { provider: "openai", model: "text-embedding-3-small" },
    });

    assert.strictEqual(parsed.enabled, true);
    assert.strictEqual(parsed.binaryPath, "/opt/pallium");
    assert.strictEqual(parsed.embedding.provider, "openai");
    // Present override is kept; absent baseUrl falls back to the default.
    assert.strictEqual(parsed.embedding.model, "text-embedding-3-small");
    assert.strictEqual(parsed.embedding.baseUrl, "");
    assert.strictEqual(parsed.indexingCadence, 15);
  }),
);

// A patch that only touches memory.binaryPath decodes to just that key, so a deep-merge applies it
// without disturbing the rest of the memory block. The embedding apiKey is never part of the patch
// shape (it lives in the secret store), so it cannot be set here.
it.effect("decodes a memory patch carrying only binaryPath", () =>
  Effect.gen(function* () {
    const patch = yield* decode(ServerSettingsPatch, {
      memory: { binaryPath: "/custom/pallium" },
    });

    assert.deepStrictEqual(patch.memory, { binaryPath: "/custom/pallium" });
    // No apiKey is representable in the memory embedding patch shape.
    const embeddingPatch = yield* decode(ServerSettingsPatch, {
      memory: { embedding: { provider: "openai", apiKey: "sk-should-be-dropped" } },
    });
    assert.deepStrictEqual(embeddingPatch.memory, { embedding: { provider: "openai" } });
  }),
);

// Full memory block survives a serialize -> decode round-trip unchanged.
it.effect("round-trips a fully specified memory block through JSON and decode", () =>
  Effect.gen(function* () {
    const original = yield* decode(MemoryServerSettings, {
      enabled: true,
      binaryPath: "pallium",
      embedding: { provider: "openai", baseUrl: "https://api.example.com/v1", model: "bge-m3" },
      indexingCadence: 30,
      storageBudgetMb: 1024,
    });

    const roundTripped = yield* decode(
      MemoryServerSettings,
      JSON.parse(JSON.stringify(original)) as unknown,
    );

    assert.deepStrictEqual(roundTripped, original);
  }),
);
