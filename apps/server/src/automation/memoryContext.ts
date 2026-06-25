import type {
  AutomationMemoryContextMode,
  MemoryDecisionList,
  MemoryFileList,
  MemorySessionList,
} from "@t3tools/contracts";

/**
 * Opt-in proactive Memory (Pallium) context bridge for automation runs.
 *
 * This module is pure formatting only: it turns the compact Memory snapshots MemoryService already
 * exposes into a short, clearly delimited context block that an automation run can START with.
 *
 * PRIME SAFETY: the bridge is additive and default-off. The caller (dispatchRun) only invokes this
 * when the definition opts in AND Pallium is available, and degrades to no injection on any failure.
 * When there is nothing useful to inject this returns null so the dispatched message stays
 * byte-identical to today.
 */

/** Preflight modes that should fetch + inject Memory context before dispatch. */
export function memoryContextModeWantsPreflight(mode: AutomationMemoryContextMode): boolean {
  return mode === "preflight" || mode === "preflight-and-postflight";
}

const MAX_CHANGED_FILES = 8;
const MAX_RISKY_FILES = 5;
const MAX_SESSIONS = 5;
const MAX_DECISIONS = 5;
const MAX_SUGGESTED_TESTS = 8;

const CONTEXT_HEADER = "=== Memory context (Pallium) ===";
const CONTEXT_FOOTER = "=== End Memory context ===";

export interface MemoryContextSnapshots {
  readonly files: MemoryFileList;
  readonly sessions: MemorySessionList;
  readonly decisions: MemoryDecisionList;
}

function isRiskyLevel(level: string): boolean {
  const normalized = level.trim().toLowerCase();
  return normalized === "high" || normalized === "medium" || normalized === "critical";
}

/**
 * Render a compact (a few hundred tokens max), clearly delimited Memory context block from the
 * snapshots, or null when there is nothing worth injecting (so dispatch stays identical to today).
 */
export function formatMemoryContextBlock(snapshots: MemoryContextSnapshots): string | null {
  const sections: string[] = [];

  const changedFiles = snapshots.files.files;
  if (changedFiles.length > 0) {
    const lines = changedFiles
      .slice(0, MAX_CHANGED_FILES)
      .map((file) => `- ${file.path} (${file.workingTreeStatus}, risk: ${file.riskLevel})`);
    sections.push(["Changed now (working tree):", ...lines].join("\n"));
  }

  const riskyFiles = changedFiles.filter((file) => isRiskyLevel(file.riskLevel));
  if (riskyFiles.length > 0) {
    const lines = riskyFiles
      .slice(0, MAX_RISKY_FILES)
      .map((file) => `- ${file.path} (risk: ${file.riskLevel})`);
    sections.push(["Risky files:", ...lines].join("\n"));
  }

  const suggestedTests = Array.from(
    new Set(changedFiles.flatMap((file) => file.suggestedTests)),
  ).slice(0, MAX_SUGGESTED_TESTS);
  if (suggestedTests.length > 0) {
    const lines = suggestedTests.map((test) => `- ${test}`);
    sections.push(["Suggested tests:", ...lines].join("\n"));
  }

  const sessions = snapshots.sessions.sessions;
  if (sessions.length > 0) {
    const lines = sessions.slice(0, MAX_SESSIONS).map((session) => {
      const label = session.title ?? session.id;
      const when = session.updatedAt ?? session.createdAt;
      return when ? `- ${label} (${when})` : `- ${label}`;
    });
    sections.push(["Related prior sessions:", ...lines].join("\n"));
  }

  const decisions = snapshots.decisions.decisions;
  if (decisions.length > 0) {
    const lines = decisions.slice(0, MAX_DECISIONS).map((decision) => {
      const label = decision.title ?? decision.sourceRef ?? "decision";
      return `- ${label}`;
    });
    sections.push(["Relevant decisions:", ...lines].join("\n"));
  }

  if (sections.length === 0) {
    return null;
  }

  return [CONTEXT_HEADER, ...sections, CONTEXT_FOOTER].join("\n\n");
}

/** Prepend the context block to the run prompt, leaving an empty/null block as a no-op. */
export function applyMemoryContext(prompt: string, contextBlock: string | null): string {
  if (!contextBlock) {
    return prompt;
  }
  return `${contextBlock}\n\n${prompt}`;
}
