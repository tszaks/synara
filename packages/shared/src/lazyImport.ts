// FILE: lazyImport.ts
// Purpose: Single-flight cache for lazy dynamic imports shared by server and web.
// Layer: Shared runtime utility

/**
 * Wraps a dynamic import (or any async loader) so every caller shares one
 * in-flight promise. A failed load clears the cache, so a transient error
 * (offline chunk fetch, missing module) is retried by the next caller instead
 * of poisoning all future calls with the same rejected promise.
 */
export function createCachedImport<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () =>
    (cached ??= load().catch((error: unknown) => {
      cached = undefined;
      throw error;
    }));
}
