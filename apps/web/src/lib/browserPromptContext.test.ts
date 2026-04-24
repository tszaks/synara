import { describe, expect, it } from "vitest";

import {
  promptLooksLikeInternalBrowserTask,
  promptShouldOpenInternalBrowserPanel,
} from "./browserPromptContext";

describe("browser prompt context", () => {
  it("opens the in-app browser panel for explicit @browser prompts", () => {
    expect(promptShouldOpenInternalBrowserPanel("@browser open https://example.com")).toBe(true);
    expect(promptShouldOpenInternalBrowserPanel("please use @browser for this")).toBe(true);
  });

  it("keeps screenshot attachment detection scoped to visual browser requests", () => {
    expect(promptLooksLikeInternalBrowserTask("@browser what do you see?")).toBe(true);
    expect(promptLooksLikeInternalBrowserTask("@browser open https://example.com")).toBe(false);
  });

  it("does not steal explicit computer-use prompts", () => {
    expect(promptShouldOpenInternalBrowserPanel("@computer-use inspect the browser")).toBe(false);
  });
});
