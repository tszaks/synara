// FILE: browserUsePolicy.test.ts
// Purpose: Covers Browser Use domain matching and navigation policy decisions.
// Layer: Desktop browser automation policy test
// Depends on: Vitest and BrowserUsePolicy

import { describe, expect, it } from "vitest";

import {
  BrowserUsePolicy,
  browserUseDomainMatches,
  isBrowserUseLocalhost,
  normalizeBrowserUseDomain,
} from "./browserUsePolicy";

describe("BrowserUsePolicy", () => {
  it("normalizes domains from bare hosts and URLs", () => {
    expect(normalizeBrowserUseDomain(" HTTPS://WWW.Example.COM/path?q=1 ")).toBe(
      "www.example.com",
    );
    expect(normalizeBrowserUseDomain("example.com")).toBe("example.com");
    expect(normalizeBrowserUseDomain("  ")).toBeNull();
  });

  it("matches exact domains and subdomains", () => {
    expect(browserUseDomainMatches("docs.example.com", "example.com")).toBe(true);
    expect(browserUseDomainMatches("badexample.com", "example.com")).toBe(false);
  });

  it("exempts localhost-style targets from site policy", () => {
    expect(isBrowserUseLocalhost("localhost")).toBe(true);
    expect(isBrowserUseLocalhost("app.localhost")).toBe(true);
    expect(isBrowserUseLocalhost("127.0.0.1")).toBe(true);
  });

  it("blocks configured domains before allowing navigation", () => {
    const policy = new BrowserUsePolicy({
      approvalMode: "always-ask",
      blockedDomains: ["example.com"],
      allowedDomains: ["docs.example.com"],
    });

    expect(policy.checkUrl("https://docs.example.com/")).toMatchObject({
      allowed: false,
      reason: "Browser Use is not permitted on docs.example.com.",
    });
  });

  it("can require domains to be explicitly allowed", () => {
    const policy = new BrowserUsePolicy({
      approvalMode: "allowed-domains",
      blockedDomains: [],
      allowedDomains: ["openai.com"],
    });

    expect(policy.checkUrl("https://chat.openai.com/")).toEqual({ allowed: true });
    expect(policy.checkUrl("https://example.com/")).toMatchObject({
      allowed: false,
      reason: "Browser Use requires approval before opening example.com.",
    });
  });
});
