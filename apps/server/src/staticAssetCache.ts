/**
 * In-process cache and compression helpers for static asset serving.
 *
 * Design notes:
 * - Only hashed (immutable) assets are body-cached; unhashed files like
 *   index.html are never cached here so stale HTML is never served.
 * - Brotli quality 6 is chosen as a practical midpoint: meaningfully smaller
 *   than gzip while keeping first-request sync compression fast enough that
 *   it does not noticeably block the event loop for typical JS/CSS chunks.
 * - The 64 MB byte cap uses simple insertion-order eviction (delete-oldest)
 *   to bound memory without the complexity of an LRU implementation.
 */

import zlib from "node:zlib";

import Mime from "@effect/platform-node/Mime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Encoding = "br" | "gzip" | "identity";

export interface StaticAssetEntry {
  readonly body: Uint8Array;
  readonly encoding: Encoding;
  readonly contentType: string;
  /** Cache-Control header value for this asset. */
  readonly cacheControl: string;
  /** ETag value (only set for unhashed files). */
  readonly etag?: string;
}

// ---------------------------------------------------------------------------
// MIME / compressibility helpers
// ---------------------------------------------------------------------------

// MIME types worth compressing. Binary image/font formats (png, jpeg, woff2)
// are excluded; wasm is kept — it compresses well under brotli/gzip and the
// cost is paid once per asset because compressed bodies are cached.
const COMPRESSIBLE_MIME_RE =
  /^(text\/|application\/(javascript|json|xml|x-www-form-urlencoded|wasm)|image\/(svg\+xml|x-icon))/;

export function isCompressible(contentType: string): boolean {
  return COMPRESSIBLE_MIME_RE.test(contentType);
}

/**
 * Resolve the best encoding from an Accept-Encoding request header value.
 * Prefers brotli, falls back to gzip, otherwise identity.
 */
export function resolveEncoding(acceptEncoding: string | undefined): Encoding {
  if (!acceptEncoding) return "identity";
  const lower = acceptEncoding.toLowerCase();
  if (lower.includes("br")) return "br";
  if (lower.includes("gzip")) return "gzip";
  return "identity";
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

export function compress(data: Uint8Array, encoding: Encoding): Uint8Array {
  if (encoding === "br") {
    return zlib.brotliCompressSync(data, {
      params: {
        // Quality 6 trades ~5 % size vs. quality 11 for a roughly 10× faster
        // sync compression time, keeping first-request latency acceptable.
        [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
      },
    });
  }
  if (encoding === "gzip") {
    return zlib.gzipSync(data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Hashed-asset detection
// ---------------------------------------------------------------------------

/**
 * Returns true for Vite content-hashed assets under the `assets/` directory.
 * These are safe to cache indefinitely.
 */
export function isHashedAsset(relativePath: string): boolean {
  // Normalise slashes so both "/" and path.sep variants match.
  const normalised = relativePath.replace(/\\/g, "/");
  return normalised.startsWith("assets/");
}

// ---------------------------------------------------------------------------
// ETag helpers (for unhashed files, e.g. index.html)
// ---------------------------------------------------------------------------

/**
 * Generates a weak ETag from file size and mtime millis.
 * This is cheap to compute and stable across reads of unchanged files.
 */
export function makeEtag(sizeBytes: number, mtimeMs: number): string {
  return `"${sizeBytes.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

// ---------------------------------------------------------------------------
// In-memory cache for hashed (immutable) assets
// ---------------------------------------------------------------------------

const CACHE_BYTE_CAP = 64 * 1024 * 1024; // 64 MB

/**
 * Map keyed by `"<absolutePath>:<encoding>"` → compressed bytes.
 * We store Map entries in insertion order so eviction removes the oldest
 * entries first when the total byte count approaches the cap.
 */
const cache = new Map<string, Uint8Array>();
let cacheBytes = 0;

function cacheKey(absolutePath: string, encoding: Encoding): string {
  return `${absolutePath}:${encoding}`;
}

function evictToFit(needed: number): void {
  const iter = cache.entries();
  while (cacheBytes + needed > CACHE_BYTE_CAP) {
    const next = iter.next();
    if (next.done) break;
    const [key, val] = next.value;
    cache.delete(key);
    cacheBytes -= val.byteLength;
  }
}

/** Returns cached compressed bytes, or undefined if not cached. */
export function getCached(absolutePath: string, encoding: Encoding): Uint8Array | undefined {
  return cache.get(cacheKey(absolutePath, encoding));
}

/** Stores compressed bytes for a hashed asset. No-op if bytes exceed the cap. */
export function putCached(absolutePath: string, encoding: Encoding, bytes: Uint8Array): void {
  const key = cacheKey(absolutePath, encoding);
  if (cache.has(key)) return; // already stored by a concurrent request
  if (bytes.byteLength > CACHE_BYTE_CAP) return; // single file too large to cache
  evictToFit(bytes.byteLength);
  cache.set(key, bytes);
  cacheBytes += bytes.byteLength;
}

/** Exposed for tests only — resets the cache to a clean state. */
export function _resetCacheForTests(): void {
  cache.clear();
  cacheBytes = 0;
}

// ---------------------------------------------------------------------------
// High-level: resolve response body for a static asset
// ---------------------------------------------------------------------------

export interface ResolveBodyInput {
  /** Absolute path to the file on disk. */
  readonly absolutePath: string;
  /** Relative path from staticRoot (used to determine hashed-asset status). */
  readonly relativePath: string;
  /** Raw bytes read from disk. */
  readonly rawBytes: Uint8Array;
  /** File size in bytes (for ETag). */
  readonly sizeBytes: number;
  /** File mtime as ms since epoch (for ETag). */
  readonly mtimeMs: number;
  /** Value of the request's Accept-Encoding header. */
  readonly acceptEncoding: string | undefined;
  /** Value of the request's If-None-Match header. */
  readonly ifNoneMatch: string | undefined;
}

export interface ResolveBodyResult {
  readonly status: 200 | 304;
  readonly body: Uint8Array | undefined; // undefined on 304
  readonly encoding: Encoding;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly etag: string | undefined;
}

export function resolveStaticBody(input: ResolveBodyInput): ResolveBodyResult {
  const contentType = Mime.getType(input.absolutePath) ?? "application/octet-stream";
  const hashed = isHashedAsset(input.relativePath);

  if (hashed) {
    const cacheControl = "public, max-age=31536000, immutable";
    const encoding = isCompressible(contentType)
      ? resolveEncoding(input.acceptEncoding)
      : "identity";

    let body = getCached(input.absolutePath, encoding);
    if (!body) {
      body = compress(input.rawBytes, encoding);
      putCached(input.absolutePath, encoding, body);
    }

    return { status: 200, body, encoding, contentType, cacheControl, etag: undefined };
  }

  // Unhashed file (index.html, etc.) — ETag + conditional GET support.
  const etag = makeEtag(input.sizeBytes, input.mtimeMs);
  const cacheControl = "no-cache";

  if (input.ifNoneMatch && input.ifNoneMatch === etag) {
    return { status: 304, body: undefined, encoding: "identity", contentType, cacheControl, etag };
  }

  const encoding = isCompressible(contentType) ? resolveEncoding(input.acceptEncoding) : "identity";
  const body = compress(input.rawBytes, encoding);

  return { status: 200, body, encoding, contentType, cacheControl, etag };
}

/** Headers for a 304 Not Modified response to a conditional static-asset request. */
export function staticNotModifiedHeaders(resolved: ResolveBodyResult): Record<string, string> {
  return {
    "Cache-Control": resolved.cacheControl,
    ...(resolved.etag ? { ETag: resolved.etag } : {}),
  };
}

/** Headers for a 200 static-asset response (Content-Type is set by the transport). */
export function staticOkHeaders(resolved: ResolveBodyResult): Record<string, string> {
  return {
    "Cache-Control": resolved.cacheControl,
    Vary: "Accept-Encoding",
    ...(resolved.encoding !== "identity" ? { "Content-Encoding": resolved.encoding } : {}),
    ...(resolved.etag ? { ETag: resolved.etag } : {}),
  };
}
