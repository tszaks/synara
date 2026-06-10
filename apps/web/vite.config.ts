// FILE: vite.config.ts
// Purpose: Builds the Synara web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react(),
    babel({
      // Scope the React Compiler to web app sources only — packages/ has no React components
      // and emits a PLUGIN_TIMINGS warning when babel processes them unnecessarily.
      include: /\/apps\/web\/src\/.*\.[jt]sx?$/,
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Vite's dynamic-import preload helper ("\0vite/preload-helper.js") is
              // shared by the entry and every lazy chunk; without a dedicated home
              // rolldown merges it into vendor-diffs, dragging that chunk back into
              // the eager entry graph.
              name: "preload-helper",
              test: /[\\/]preload-helper\.js/,
              priority: 11,
            },
            { name: "vendor-effect", test: /[\\/]node_modules[\\/]effect[\\/]/, priority: 10 },
            { name: "vendor-xterm", test: /[\\/]node_modules[\\/]@xterm[\\/]/, priority: 10 },
            {
              name: "vendor-lexical",
              test: /[\\/]node_modules[\\/](?:lexical|@lexical)[\\/]/,
              priority: 10,
            },
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](?:react|react-dom)[\\/]/,
              priority: 10,
            },
            { name: "vendor-tanstack", test: /[\\/]node_modules[\\/]@tanstack[\\/]/, priority: 9 },
            {
              // Claims the eagerly-loaded markdown/HAST ecosystem (react-markdown +
              // unified/micromark closure). Without an explicit group, rolldown hoists
              // the utilities shared with lazy shiki/diff code (property-information,
              // *-separated-tokens, ccount, hast-util-whitespace, zwitch) into
              // vendor-diffs, which forces that chunk into the eager entry graph.
              // hast-util-to-html and its private deps are intentionally excluded:
              // they are lazy-only and must stay out of the eager chunk.
              name: "vendor-markdown",
              test: /[\\/]node_modules[\\/](?:react-markdown|remark-[a-z-]+|rehype-[a-z-]+|micromark(?:-[a-z-]+)?|mdast-util-[a-z-]+|hast-util-(?:from-dom|from-html-isomorphic|is-element|parse-selector|to-jsx-runtime|to-text|whitespace)|hastscript|unist-util-[a-z-]+|unified|vfile(?:-message)?|bail|trough|devlop|zwitch|ccount|longest-streak|markdown-table|trim-lines|extend|is-plain-obj|escape-string-regexp|decode-named-character-reference|estree-util-is-identifier-name|comma-separated-tokens|space-separated-tokens|property-information|html-url-attributes|style-to-(?:js|object)|inline-style-parser|web-namespaces|@ungap[\\/]structured-clone)[\\/]/,
              priority: 9,
            },
            { name: "vendor-diffs", test: /[\\/]node_modules[\\/]@pierre[\\/]/, priority: 9 },
          ],
        },
      },
    },
  },
});
