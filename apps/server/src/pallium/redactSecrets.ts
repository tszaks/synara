/**
 * Secret redaction for the Pallium binary boundary.
 *
 * The Pallium CLI receives an embedding API key via the environment (PR4/PR11) and may echo
 * configuration back on stdout/stderr. Before any Pallium stdout/stderr is logged or wrapped in
 * an error, run it through `redactSecrets` so a key shape never lands in a log line or surfaced
 * error message.
 *
 * This is a deliberately separate copy from the automation redaction helper
 * (`automation/Layers/AutomationService.ts`). Keeping it standalone avoids coupling the Pallium
 * boundary to automation internals; both share the same regex shapes intentionally.
 */

const MAX_REDACTED_CHARS = 4_000;

/** Redact common secret shapes before logging/surfacing Pallium stdout or stderr. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /\b(authorization|bearer|token|api[_-]?key|secret|password)\b(\s*[=:]\s*|\s+)\S+/gi,
      "$1=[redacted]",
    );
}

/** Turn an unknown cause into a redacted, length-bounded message safe to surface or log. */
export function redactedErrorMessage(cause: unknown): string {
  const raw =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
  return redactSecrets(raw).slice(0, MAX_REDACTED_CHARS);
}
