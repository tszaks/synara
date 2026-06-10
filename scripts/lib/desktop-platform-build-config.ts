// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

export const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
const MAC_AFTER_PACK_HOOK_PATH = "./electron-builder-after-pack.cjs";
const MAC_DMG_ICON_PATH = "icon.icns";
export interface DesktopPlatformBuildConfig {
  readonly afterPack?: string;
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
  readonly dmg?: {
    readonly icon: string;
  };
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hasMacIconComposer: boolean;
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly windowsAzureSignOptions?: Record<string, string>;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

// Maps electron-builder platform names to the OS-level subdirectory inside node-pty/prebuilds.
const PLATFORM_TO_PREBUILD_OS: Record<"linux" | "mac" | "win", string> = {
  mac: "darwin",
  win: "win32",
  linux: "linux",
};

// All OS prefixes that node-pty ships prebuilds for.
const ALL_PREBUILD_OS_PREFIXES = ["darwin", "win32", "linux"] as const;

/**
 * Returns the asarUnpack glob for the target platform+arch and the files-negation
 * patterns that strip foreign-platform prebuilds from the installer.
 *
 * asarUnpack only controls which files are *extracted* from the asar archive — it
 * does not remove foreign prebuilds from the packaged app. The files exclusion is
 * required to actually shrink the download size.
 */
export function resolveNodePtyPackaging(
  platform: "linux" | "mac" | "win",
  arch: "arm64" | "x64" | "universal",
): { asarUnpack: ReadonlyArray<string>; filesExclude: ReadonlyArray<string> } {
  if (arch === "universal" && platform !== "mac") {
    // A win32-universal/linux-universal prebuild dir does not exist, so the
    // asarUnpack glob would silently match nothing and the app would ship
    // without a usable pty binary. Fail loudly instead.
    throw new Error(`Universal desktop builds are only supported on mac, not ${platform}.`);
  }
  const targetOs = PLATFORM_TO_PREBUILD_OS[platform];

  // For a universal macOS build, unpack both darwin archs.
  const targetPrebuildDirs =
    arch === "universal" && platform === "mac"
      ? [
          `node_modules/node-pty/prebuilds/darwin-arm64`,
          `node_modules/node-pty/prebuilds/darwin-x64`,
        ]
      : [`node_modules/node-pty/prebuilds/${targetOs}-${arch}`];

  const asarUnpack = [
    ...targetPrebuildDirs.map((d) => `${d}/**`),
    // Non-prebuild runtime files required at startup.
    "node_modules/node-pty/lib/**",
    "node_modules/node-pty/package.json",
  ];

  // Exclude every prebuild directory that is NOT needed for the target platform.
  const filesExclude = ALL_PREBUILD_OS_PREFIXES.flatMap((os) => {
    if (os !== targetOs) {
      // Entire foreign OS — exclude everything.
      return [`!node_modules/node-pty/prebuilds/${os}-*/**`];
    }
    if (arch === "universal") {
      // Universal builds keep both darwin archs; nothing to exclude within darwin.
      return [];
    }
    // Same OS but wrong arch — exclude sibling arch dirs.
    const sibling = arch === "arm64" ? "x64" : "arm64";
    return [`!node_modules/node-pty/prebuilds/${os}-${sibling}/**`];
  });

  return { asarUnpack, filesExclude };
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const { asarUnpack, filesExclude } = resolveNodePtyPackaging(input.platform, input.arch);
  const nativePackaging = {
    asarUnpack,
    ...(filesExclude.length > 0 ? { files: ["**/*", ...filesExclude] } : {}),
  };

  if (input.platform === "mac") {
    const mac = {
      target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
      icon: input.hasMacIconComposer ? "icon.icon" : MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
        ...(input.hasMacIconComposer ? { CFBundleIconFile: MAC_DMG_ICON_PATH } : {}),
      },
    } satisfies Record<string, unknown>;

    if (!input.hasMacIconComposer) {
      return { ...nativePackaging, mac };
    }

    return {
      ...nativePackaging,
      mac,
      afterPack: MAC_AFTER_PACK_HOOK_PATH,
      dmg: {
        icon: MAC_DMG_ICON_PATH,
      },
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      linux: {
        target: [input.target],
        executableName: "synara",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "synara",
          },
        },
      },
    };
  }

  return {
    ...nativePackaging,
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions ? { azureSignOptions: input.windowsAzureSignOptions } : {}),
    },
  };
}
