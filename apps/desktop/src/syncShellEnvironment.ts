// FILE: syncShellEnvironment.ts
// Purpose: Hydrates Electron's inherited env with values from the user's login shell.
// Exports: syncShellEnvironmentAsync for non-blocking desktop startup,
//          and syncShellEnvironment for tests that need the synchronous API.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildEnvironmentCaptureCommand,
  isPathName,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readEnvironmentFromLoginShell,
  readWindowsPersistentEnvironment,
  type ShellEnvironmentReader,
  type WindowsEnvironmentReader,
} from "@t3tools/shared/shell";

const execFileAsync = promisify(execFile);

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

function logShellEnvironmentWarning(message: string, error?: unknown): void {
  console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

// Windows GUI processes inherit a (possibly stale) environment block instead of a login
// shell. Hydrate PATH and any missing variables from the persisted registry environment so
// CLI providers resolve the same config the user's terminal sees (e.g. CLAUDE_CONFIG_DIR).
function syncWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  readWindowsEnvironment: WindowsEnvironmentReader,
  logWarning: (message: string, error?: unknown) => void,
): void {
  try {
    const persisted = readWindowsEnvironment();

    const mergedPath = mergePathEntries(persisted.PATH, env.PATH, "win32");
    if (mergedPath) {
      env.PATH = mergedPath;
    }

    for (const [name, value] of Object.entries(persisted)) {
      if (isPathName(name)) continue;
      if (value && env[name] === undefined) {
        env[name] = value;
      }
    }
  } catch (error) {
    logWarning("Failed to synchronize the desktop Windows environment.", error);
  }
}

/**
 * Async login-shell environment reader. Uses non-blocking execFile so the Electron
 * main thread is not stalled by heavy shell rc files (50–200 ms on macOS).
 * Parsing is delegated back to readEnvironmentFromLoginShell via a pre-fetched output stub.
 */
async function readLoginShellEnvAsync(
  shell: string,
  names: ReadonlyArray<string>,
): Promise<Partial<Record<string, string>>> {
  if (names.length === 0) return {};

  const { stdout } = await execFileAsync(shell, ["-ilc", buildEnvironmentCaptureCommand(names)], {
    encoding: "utf8",
    timeout: 10_000,
  });

  // Re-use the shared reader's parser by injecting a no-op execFile that returns the
  // already-fetched output. This avoids duplicating the extraction logic.
  return readEnvironmentFromLoginShell(shell, names, (_file, _args, _opts) => stdout);
}

export interface SyncShellEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly readEnvironment?: ShellEnvironmentReader;
  readonly readLaunchctlPath?: typeof readPathFromLaunchctl;
  readonly readWindowsEnvironment?: WindowsEnvironmentReader;
  readonly userShell?: string;
  readonly logWarning?: (message: string, error?: unknown) => void;
}

/**
 * Asynchronously hydrates process.env with values from the user's login shell.
 * Kick off early at module load (before app.whenReady) and await before spawning
 * the backend child process so it inherits the correct PATH.
 * On Windows the sync registry read is retained (fast, no shell spawn needed).
 */
export async function syncShellEnvironmentAsync(
  env: NodeJS.ProcessEnv = process.env,
  options: SyncShellEnvironmentOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const logWarning = options.logWarning ?? logShellEnvironmentWarning;

  if (platform === "win32") {
    // Windows registry read is fast (no shell spawn); keep synchronous.
    syncWindowsEnvironment(
      env,
      options.readWindowsEnvironment ?? readWindowsPersistentEnvironment,
      logWarning,
    );
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  const shellEnvironment: Partial<Record<string, string>> = {};

  try {
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        let result: Partial<Record<string, string>>;
        if (options.readEnvironment) {
          // Test/override path: call the provided sync reader as-is.
          result = options.readEnvironment(shell, LOGIN_SHELL_ENV_NAMES);
        } else {
          result = await readLoginShellEnvAsync(shell, LOGIN_SHELL_ENV_NAMES);
        }
        Object.assign(shellEnvironment, result);
        if (shellEnvironment.PATH) {
          break;
        }
      } catch (error) {
        logWarning(`Failed to read login shell environment from ${shell}.`, error);
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellEnvironment.PATH
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellEnvironment.PATH ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of [
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      if (!env[name] && shellEnvironment[name]) {
        env[name] = shellEnvironment[name];
      }
    }
  } catch (error) {
    logWarning("Failed to synchronize the desktop shell environment.", error);
  }
}

/**
 * Synchronous variant retained for test compatibility.
 * The desktop main process should use syncShellEnvironmentAsync instead.
 */
export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: SyncShellEnvironmentOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const logWarning = options.logWarning ?? logShellEnvironmentWarning;

  if (platform === "win32") {
    syncWindowsEnvironment(
      env,
      options.readWindowsEnvironment ?? readWindowsPersistentEnvironment,
      logWarning,
    );
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
  const shellEnvironment: Partial<Record<string, string>> = {};

  try {
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        Object.assign(shellEnvironment, readEnvironment(shell, LOGIN_SHELL_ENV_NAMES));
        if (shellEnvironment.PATH) {
          break;
        }
      } catch (error) {
        logWarning(`Failed to read login shell environment from ${shell}.`, error);
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellEnvironment.PATH
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellEnvironment.PATH ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of [
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      if (!env[name] && shellEnvironment[name]) {
        env[name] = shellEnvironment[name];
      }
    }
  } catch (error) {
    logWarning("Failed to synchronize the desktop shell environment.", error);
  }
}
