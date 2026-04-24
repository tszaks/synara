// FILE: browserUse.test.ts
// Purpose: Verifies shared browser-use discovery paths stay aligned with Codex.
// Layer: Shared runtime config test
// Depends on: Vitest and browserUse constants

import { describe, expect, it } from "vitest";

import { DPCODE_BROWSER_USE_IAB_PIPE_PATHS, resolveBrowserUseIabPipePath } from "./browserUse";

describe("browserUse socket constants", () => {
  it("resolves the Codex IAB socket path per platform", () => {
    expect(resolveBrowserUseIabPipePath("darwin")).toBe("/tmp/codex-browser-use-iab.sock");
    expect(resolveBrowserUseIabPipePath("linux")).toBe("/tmp/codex-browser-use-iab.sock");
    expect(resolveBrowserUseIabPipePath("win32")).toBe(String.raw`\\.\pipe\codex-browser-use-iab`);
  });

  it("exposes one canonical IAB backend to avoid duplicate session owners", () => {
    expect(DPCODE_BROWSER_USE_IAB_PIPE_PATHS).toEqual(["/tmp/codex-browser-use-iab.sock"]);
  });
});
