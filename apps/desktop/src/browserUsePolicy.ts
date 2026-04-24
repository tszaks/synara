// FILE: browserUsePolicy.ts
// Purpose: Applies Browser Use domain policy before agent-driven navigation.
// Layer: Desktop browser automation policy
// Exports: BrowserUsePolicy and helpers for domain normalization/matching.

import type { BrowserUsePolicyState } from "@t3tools/contracts";

export interface BrowserUseUrlDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

interface CachedBrowserUseUrlDecision {
  readonly expiresAt: number;
  readonly decision: BrowserUseUrlDecision;
}

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const BROWSER_USE_POLICY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_BROWSER_USE_POLICY: BrowserUsePolicyState = {
  approvalMode: "always-ask",
  blockedDomains: [],
  allowedDomains: [],
};

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

export function normalizeBrowserUseDomain(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return normalizeHostname(parsed.hostname);
  } catch {
    return normalizeHostname(trimmed);
  }
}

export function isBrowserUseLocalhost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return LOCALHOST_HOSTS.has(normalized) || normalized.endsWith(".localhost");
}

export function browserUseDomainMatches(hostname: string, rule: string): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedRule = normalizeBrowserUseDomain(rule);
  if (!normalizedRule) {
    return false;
  }
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

export class BrowserUsePolicy {
  private state: BrowserUsePolicyState;
  private readonly decisionCache = new Map<string, CachedBrowserUseUrlDecision>();

  constructor(initialState: BrowserUsePolicyState = DEFAULT_BROWSER_USE_POLICY) {
    this.state = {
      approvalMode: initialState.approvalMode,
      blockedDomains: [...initialState.blockedDomains],
      allowedDomains: [...initialState.allowedDomains],
    };
  }

  read(): BrowserUsePolicyState {
    return {
      approvalMode: this.state.approvalMode,
      blockedDomains: [...this.state.blockedDomains],
      allowedDomains: [...this.state.allowedDomains],
    };
  }

  update(nextState: BrowserUsePolicyState): BrowserUsePolicyState {
    this.state = {
      approvalMode: nextState.approvalMode,
      blockedDomains: [
        ...new Set(
          nextState.blockedDomains.flatMap((entry) => normalizeBrowserUseDomain(entry) ?? []),
        ),
      ],
      allowedDomains: [
        ...new Set(
          nextState.allowedDomains.flatMap((entry) => normalizeBrowserUseDomain(entry) ?? []),
        ),
      ],
    };
    this.decisionCache.clear();
    return this.read();
  }

  checkUrl(rawUrl: string): BrowserUseUrlDecision {
    const cacheKey = this.createCacheKey(rawUrl);
    const cached = this.decisionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.decision;
    }

    const decision = this.computeUrlDecision(rawUrl);
    this.decisionCache.set(cacheKey, {
      decision,
      expiresAt: Date.now() + BROWSER_USE_POLICY_CACHE_TTL_MS,
    });
    return decision;
  }

  private computeUrlDecision(rawUrl: string): BrowserUseUrlDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return {
        allowed: false,
        reason: "Browser Use cannot visit the requested page because the URL is invalid.",
      };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "about:") {
      return {
        allowed: false,
        reason: "Browser Use can only open http, https, and about: URLs.",
      };
    }

    if (url.protocol === "about:" || isBrowserUseLocalhost(url.hostname)) {
      return { allowed: true };
    }

    const blockedRule = this.state.blockedDomains.find((rule) =>
      browserUseDomainMatches(url.hostname, rule),
    );
    if (blockedRule) {
      return {
        allowed: false,
        reason: `Browser Use is not permitted on ${url.hostname}.`,
      };
    }

    if (this.state.approvalMode === "allowed-domains") {
      const allowed = this.state.allowedDomains.some((rule) =>
        browserUseDomainMatches(url.hostname, rule),
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Browser Use requires approval before opening ${url.hostname}.`,
        };
      }
    }

    return { allowed: true };
  }

  private createCacheKey(rawUrl: string): string {
    return JSON.stringify([this.state, rawUrl]);
  }

  assertUrlAllowed(rawUrl: string): void {
    const decision = this.checkUrl(rawUrl);
    if (!decision.allowed) {
      throw new Error(decision.reason ?? "Browser Use is not permitted on this site.");
    }
  }
}
