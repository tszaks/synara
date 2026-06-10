import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MICROPHONE_USAGE_DESCRIPTION,
  resolveNodePtyPackaging,
  validateDesktopNativeBuildHost,
} from "./lib/desktop-platform-build-config.ts";

describe("createDesktopPlatformBuildConfig", () => {
  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      arch: "arm64",
      target: "dmg",
      hasMacIconComposer: false,
    });
    const mac = config.mac as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.ok(
      config.asarUnpack?.includes("node_modules/node-pty/prebuilds/darwin-arm64/**"),
      "asarUnpack should include target arch prebuild",
    );
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(config.afterPack, undefined);
    assert.equal(config.dmg, undefined);
  });

  it("preserves the icon composer packaging path for macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      arch: "arm64",
      target: "dmg",
      hasMacIconComposer: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.equal(mac.icon, "icon.icon");
    assert.ok(
      config.asarUnpack?.includes("node_modules/node-pty/prebuilds/darwin-arm64/**"),
      "asarUnpack should include target arch prebuild",
    );
    assert.equal(extendInfo.CFBundleIconFile, "icon.icns");
    assert.equal(config.afterPack, "./electron-builder-after-pack.cjs");
    assert.deepStrictEqual(config.dmg, { icon: "icon.icns" });
  });

  it("leaves non-macOS platform configs unchanged", () => {
    const linux = createDesktopPlatformBuildConfig({
      platform: "linux",
      arch: "x64",
      target: "AppImage",
      hasMacIconComposer: false,
    });
    const win = createDesktopPlatformBuildConfig({
      platform: "win",
      arch: "x64",
      target: "nsis",
      hasMacIconComposer: false,
      windowsAzureSignOptions: { publisherName: "T3 Tools" },
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.afterPack, undefined);
    assert.ok(
      linux.asarUnpack?.includes("node_modules/node-pty/prebuilds/linux-x64/**"),
      "linux asarUnpack should include linux-x64 prebuild",
    );
    assert.deepStrictEqual(linux.linux, {
      target: ["AppImage"],
      executableName: "synara",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "synara",
        },
      },
    });

    assert.equal(win.mac, undefined);
    assert.ok(
      win.asarUnpack?.includes("node_modules/node-pty/prebuilds/win32-x64/**"),
      "win asarUnpack should include win32-x64 prebuild",
    );
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      azureSignOptions: { publisherName: "T3 Tools" },
    });
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "linux",
      arch: "arm64",
      target: "AppImage",
      hasMacIconComposer: false,
    });

    assert.ok(
      config.asarUnpack?.includes("node_modules/node-pty/prebuilds/linux-arm64/**"),
      "asarUnpack should include linux-arm64 prebuild",
    );
    assert.ok(
      config.asarUnpack?.includes("node_modules/node-pty/lib/**"),
      "asarUnpack should include lib dir",
    );
  });

  it("excludes foreign-platform prebuilds from the files list on mac/arm64", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      arch: "arm64",
      target: "dmg",
      hasMacIconComposer: false,
    });

    assert.ok(Array.isArray(config.files), "files should be set to exclude foreign prebuilds");
    assert.ok(
      config.files?.includes("!node_modules/node-pty/prebuilds/win32-*/**"),
      "should exclude win32 prebuilds",
    );
    assert.ok(
      config.files?.includes("!node_modules/node-pty/prebuilds/linux-*/**"),
      "should exclude linux prebuilds",
    );
    assert.ok(
      config.files?.includes("!node_modules/node-pty/prebuilds/darwin-x64/**"),
      "should exclude darwin-x64 when building for arm64",
    );
    assert.ok(
      !config.files?.includes("!node_modules/node-pty/prebuilds/darwin-arm64/**"),
      "should NOT exclude darwin-arm64 (target arch)",
    );
  });

  it("keeps both darwin archs for universal mac builds", () => {
    const { asarUnpack, filesExclude } = resolveNodePtyPackaging("mac", "universal");

    assert.ok(
      asarUnpack.includes("node_modules/node-pty/prebuilds/darwin-arm64/**"),
      "should unpack darwin-arm64 for universal",
    );
    assert.ok(
      asarUnpack.includes("node_modules/node-pty/prebuilds/darwin-x64/**"),
      "should unpack darwin-x64 for universal",
    );
    assert.ok(
      filesExclude.every((g) => !g.includes("darwin")),
      "should not exclude any darwin prebuilds for universal",
    );
    assert.ok(
      filesExclude.some((g) => g.includes("win32")),
      "should exclude win32 prebuilds for universal mac",
    );
  });

  it("rejects universal builds for non-mac platforms", () => {
    assert.throws(
      () => resolveNodePtyPackaging("win", "universal"),
      /Universal desktop builds are only supported on mac, not win\./,
    );
    assert.throws(
      () => resolveNodePtyPackaging("linux", "universal"),
      /Universal desktop builds are only supported on mac, not linux\./,
    );
  });

  it("blocks unsupported or non-matching Linux native build hosts", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      null,
    );

    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "universal",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      "Linux desktop artifacts support x64 or arm64 builds, not universal builds.",
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    assert.ok(issue?.includes("Build linux/x64 on a matching Linux host"));
  });
});
