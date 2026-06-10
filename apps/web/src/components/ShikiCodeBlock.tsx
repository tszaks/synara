// FILE: ShikiCodeBlock.tsx
// Purpose: Suspense-driven Shiki syntax highlighting for chat markdown code fences.
// Layer: Web chat presentation component (lazy)
// Exports: default SuspenseShikiCodeBlock, resolveFenceLanguage
// Depends on: @pierre/diffs shared highlighter — this module is React.lazy-loaded by
//             ChatMarkdown so the vendor-diffs chunk stays out of the eager bundle.
//             While the chunk (and then the highlighter) load, the Suspense fallback
//             in ChatMarkdown shows the same plain <pre> it always has.

import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { use, useEffect, useMemo } from "react";

import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

// Resolves the highlighter language for a parsed fence. File references carry
// `language: null` (codeFence.ts is kept free of @pierre/diffs); reuse the diff
// renderer's filename→language map here so chat code references and diff views
// resolve languages identically. Unknown extensions yield "text".
export function resolveFenceLanguage(
  language: string | null,
  fileName: string | null | undefined,
): string {
  if (language != null) {
    return language;
  }
  return getFiletypeFromFileName(fileName ?? "");
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

interface SuspenseShikiCodeBlockProps {
  language: string | null;
  fileName: string | null;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

export default function SuspenseShikiCodeBlock({
  language,
  fileName,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const resolvedLanguage = resolveFenceLanguage(language, fileName);
  const cacheKey = createHighlightCacheKey(code, resolvedLanguage, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  // The hook-using path lives in a child component so this early return can never
  // change the hook count of a single instance across renders (a cache miss→hit
  // flip would otherwise crash with "Rendered fewer hooks than expected").
  return (
    <HighlightedShikiCode
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
      resolvedLanguage={resolvedLanguage}
      cacheKey={cacheKey}
    />
  );
}

function HighlightedShikiCode({
  code,
  themeName,
  isStreaming,
  resolvedLanguage,
  cacheKey,
}: {
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  resolvedLanguage: string;
  cacheKey: string;
}) {
  const highlighter = use(getHighlighterPromise(resolvedLanguage));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: resolvedLanguage, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${resolvedLanguage}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, resolvedLanguage, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}
