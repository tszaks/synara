// Covers the filename→language resolution that moved out of codeFence.ts so the
// eager markdown path stays free of @pierre/diffs. These cases previously lived
// in codeFence.test.ts and must keep matching the diff renderer's mapping.
import { describe, expect, it } from "vitest";
import { resolveFenceLanguage } from "./ShikiCodeBlock";

describe("resolveFenceLanguage", () => {
  it("keeps explicit fence languages untouched", () => {
    expect(resolveFenceLanguage("ts", null)).toBe("ts");
    expect(resolveFenceLanguage("text", "model.ts")).toBe("text");
  });

  it("derives the language from the referenced file name", () => {
    expect(resolveFenceLanguage(null, "model.ts")).toBe("typescript");
    expect(resolveFenceLanguage(null, "app.tsx")).toBe("tsx");
    expect(resolveFenceLanguage(null, "index.py")).toBe("python");
    expect(resolveFenceLanguage(null, "Dockerfile")).toBe("dockerfile");
  });

  it("falls back to text for unknown extensions and missing file names", () => {
    expect(resolveFenceLanguage(null, "notes.unknownext")).toBe("text");
    expect(resolveFenceLanguage(null, null)).toBe("text");
  });
});
