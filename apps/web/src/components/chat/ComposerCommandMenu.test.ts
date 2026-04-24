import { describe, expect, it } from "vitest";
import { groupCommandItems, type ComposerCommandItem } from "./ComposerCommandMenu";

describe("groupCommandItems", () => {
  it("groups mention suggestions as browser, plugins, local, then subagents", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "browser",
        type: "browser",
        label: "@browser",
        description: "Use DP Code's in-app browser",
      },
      {
        id: "agent:codex:mini",
        type: "agent",
        provider: "codex",
        alias: "mini",
        color: "violet",
        label: "@mini",
        description: "GPT-5.4 Mini",
      },
      {
        id: "path:file:/workspace/AGENTS.md",
        type: "path",
        path: "/workspace/AGENTS.md",
        pathKind: "file",
        label: "AGENTS.md",
        description: "/workspace",
      },
      {
        id: "plugin:github",
        type: "plugin",
        plugin: {
          id: "plugin/github",
          name: "GitHub",
          source: {
            type: "local",
            path: "/test/plugins/github",
          },
          interface: {
            displayName: "GitHub",
            shortDescription: "Triage PRs and CI",
          },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          authPolicy: "ON_USE",
        },
        mention: {
          name: "GitHub",
          path: "plugin://GitHub@codex",
        },
        label: "GitHub",
        description: "Triage PRs and CI",
      },
      {
        id: "local-root",
        type: "local-root",
        label: "@local",
        description: "Browse folders on this computer",
      },
    ];

    expect(groupCommandItems(items, "mention", true)).toEqual([
      {
        id: "browser",
        label: "Browser",
        items: [items[0]],
      },
      {
        id: "plugins",
        label: "Plugins",
        items: [items[3]],
      },
      {
        id: "local",
        label: "Local",
        items: [items[2], items[4]],
      },
      {
        id: "subagents",
        label: "Subagents",
        items: [items[1]],
      },
    ]);
  });
});
