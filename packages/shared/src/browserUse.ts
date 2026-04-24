// FILE: browserUse.ts
// Purpose: Shares Codex browser-use socket discovery constants across processes.
// Layer: Shared runtime config
// Exports: resolveBrowserUseIabPipePath and DPCODE_BROWSER_USE_IAB_PIPE_PATH

export function resolveBrowserUseIabPipePath(platform = process.platform): string {
  if (platform === "win32") {
    return String.raw`\\.\pipe\codex-browser-use-iab`;
  }
  return "/tmp/codex-browser-use-iab.sock";
}

export const DPCODE_BROWSER_USE_IAB_PIPE_PATH = resolveBrowserUseIabPipePath();
export const DPCODE_BROWSER_USE_IAB_PIPE_PATHS = [DPCODE_BROWSER_USE_IAB_PIPE_PATH] as const;
