// FILE: 050_AutomationMemoryContextMode.ts
// Purpose: Adds the opt-in Memory context bridge mode to automations. Defaults to 'off' so every
//          existing row keeps its exact prior behavior (no Memory context injected at dispatch).
// Layer: Server persistence migration
// Depends on: automation_definitions and schemaHelpers.columnExists.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "memory_context_mode"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN memory_context_mode TEXT NOT NULL DEFAULT 'off'
    `;
  }
});
