// FILE: sdkLoaders.ts
// Purpose: Cached lazy loaders for heavy provider SDKs. Importing these module graphs
// at boot adds noticeable startup cost, so each SDK loads once, on first use, and every
// consumer (adapters, health checks) shares the same in-flight promise. A failed load
// clears the cache so a transient error does not poison every later session.

import { createCachedImport } from "@t3tools/shared/lazyImport";

export const loadClaudeSdk = createCachedImport(() => import("@anthropic-ai/claude-agent-sdk"));

export const loadPiCodingAgent = createCachedImport(
  () => import("@earendil-works/pi-coding-agent"),
);

export const loadPiAi = createCachedImport(() => import("@earendil-works/pi-ai"));
