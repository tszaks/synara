// FILE: patchParsing.ts
// Purpose: Parse raw git patches into renderable file diffs and summary totals.
// Layer: Web diff utilities
// Depends on: @pierre/diffs patch parsing — this is the ONLY module that may import
//             @pierre/diffs runtime code outside lazy-loaded diff surfaces. Keeping the
//             parser separate from diffRendering.ts keeps the 475 kB vendor-diffs chunk
//             out of the eager route bundle; eager callers must dynamic-import this file.

import { parsePatchFiles } from "@pierre/diffs";

import {
  buildPatchCacheKey,
  summarizeRenderablePatchStats,
  type RenderablePatch,
} from "./diffRendering";

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

export function summarizePatchTotals(
  patch: string | undefined,
): { additions: number; deletions: number; fileCount: number } | null {
  const renderable = getRenderablePatch(patch, "diff-panel:stats");
  return summarizeRenderablePatchStats(renderable);
}
