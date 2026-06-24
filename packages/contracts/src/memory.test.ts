import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { PalliumDoctorResult, PalliumStatus, PalliumVersionResult } from "./memory";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("decodes `pallium version --json` output", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PalliumVersionResult, {
      module: "github.com/tszaks/pallium",
      version: "v0.4.0",
      go_version: "go1.26.0",
      vcs_revision: "abc123",
      vcs_modified: "false",
      executable: "/usr/local/bin/pallium",
    });
    assert.strictEqual(parsed.version, "v0.4.0");
    assert.strictEqual(parsed.module, "github.com/tszaks/pallium");
  }),
);

it.effect("decodes version output without the optional omitempty fields", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PalliumVersionResult, {
      module: "github.com/tszaks/pallium",
      version: "dev",
      go_version: "go1.26.0",
    });
    assert.strictEqual(parsed.version, "dev");
    assert.strictEqual(parsed.vcs_revision, undefined);
    assert.strictEqual(parsed.executable, undefined);
  }),
);

it.effect("decodes `pallium doctor --json` output with nested session stats", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PalliumDoctorResult, {
      repo_root: "/Users/tyler/Projects/synara-auto",
      repo_db_path: "/Users/tyler/Projects/synara-auto/.pallium/pallium.sqlite",
      repo_db_exists: true,
      index_status: "indexed",
      indexed_branch: "main",
      last_indexed_commit: "deadbeef",
      indexed_at: "2026-06-24T12:00:00Z",
      current_branch: "main",
      current_commit: "deadbeef",
      working_tree_dirty: false,
      working_tree_file_count: 0,
      session_db_path: "/Users/tyler/.pallium/codex-sessions.sqlite",
      session_db_exists: true,
      session_stats: {
        sessions: 12,
        events: 340,
        messages: 210,
        chunks: 88,
        embeddings: 88,
        models: [{ provider: "ollama", model: "nomic-embed-text", dim: 768, count: 88 }],
      },
      embedding_model: "nomic-embed-text",
      embedding_backlog: 0,
      openai_key_available: false,
      executable_path: "/usr/local/bin/pallium",
      recommended_next_command: "pallium changed-now",
      notes: ["index is fresh"],
    });
    assert.strictEqual(parsed.index_status, "indexed");
    assert.strictEqual(parsed.session_stats.chunks, 88);
    assert.strictEqual(parsed.session_stats.models?.[0]?.provider, "ollama");
    assert.strictEqual(parsed.openai_key_available, false);
  }),
);

it.effect("decodes a minimal unindexed doctor report (no optional fields, no models)", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PalliumDoctorResult, {
      repo_root: "/tmp/repo",
      repo_db_path: "/tmp/repo/.pallium/pallium.sqlite",
      repo_db_exists: false,
      index_status: "missing",
      working_tree_dirty: false,
      working_tree_file_count: 0,
      session_db_path: "/Users/tyler/.pallium/codex-sessions.sqlite",
      session_db_exists: false,
      session_stats: { sessions: 0, events: 0, messages: 0, chunks: 0, embeddings: 0 },
      embedding_model: "",
      embedding_backlog: 0,
      openai_key_available: false,
    });
    assert.strictEqual(parsed.index_status, "missing");
    assert.strictEqual(parsed.indexed_branch, undefined);
    assert.strictEqual(parsed.session_stats.models, undefined);
  }),
);

it.effect("decodes an unavailable PalliumStatus (Pallium absent)", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PalliumStatus, {
      available: false,
      capabilities: { indexed: false, embeddings: false, openaiKeyAvailable: false },
      checkedAt: "2026-06-24T12:00:00Z",
      reason: "pallium not found on PATH",
    });
    assert.strictEqual(parsed.available, false);
    assert.strictEqual(parsed.capabilities.indexed, false);
    assert.strictEqual(parsed.reason, "pallium not found on PATH");
  }),
);

it.effect("decodes an available PalliumStatus with capabilities", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PalliumStatus, {
      available: true,
      binaryPath: "pallium",
      version: "v0.4.0",
      capabilities: { indexed: true, embeddings: true, openaiKeyAvailable: false },
      checkedAt: "2026-06-24T12:00:00Z",
    });
    assert.strictEqual(parsed.available, true);
    assert.strictEqual(parsed.capabilities.embeddings, true);
    assert.strictEqual(parsed.reason, undefined);
  }),
);
