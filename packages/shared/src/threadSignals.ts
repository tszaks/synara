// FILE: threadSignals.ts
// Purpose: Shared helpers for lightweight thread/sidebar signals derived from messages, plans, and activities.
// Exports: Pure signal helpers used by server snapshot projection and web live state reconciliation.

import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  UserInputQuestion,
} from "@t3tools/contracts";
import { ApprovalRequestId } from "@t3tools/contracts";

type MessageLike = Pick<OrchestrationMessage, "role" | "createdAt">;
type ProposedPlanLike = Pick<
  OrchestrationProposedPlan,
  "id" | "turnId" | "updatedAt" | "implementedAt"
>;
type ApprovalRequestKind = "command" | "file-read" | "file-change";

export interface PendingApprovalSignal {
  requestId: ApprovalRequestId;
  requestKind: ApprovalRequestKind;
  createdAt: string;
  detail?: string;
}

export interface PendingUserInputSignal {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function compareThreadActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function requestKindFromRequestType(requestType: unknown): ApprovalRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function requestKindFromActivityPayload(
  payload: Record<string, unknown> | null,
): ApprovalRequestKind | null {
  if (!payload) {
    return null;
  }
  if (
    payload.requestKind === "command" ||
    payload.requestKind === "file-read" ||
    payload.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload.requestType);
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingApprovalSignals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingApprovalSignal> {
  const openByRequestId = new Map<ApprovalRequestId, PendingApprovalSignal>();

  for (const activity of [...activities].toSorted(compareThreadActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId =
      typeof payload?.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
    const requestKind = requestKindFromActivityPayload(payload);

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }
    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

// Keep reconnect/startup summaries aligned with live UI by applying the same request-shape guards.
export function hasPendingApprovalsSignal(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  return derivePendingApprovalSignals(activities).length > 0;
}

export function derivePendingUserInputSignals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingUserInputSignal> {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInputSignal>();

  for (const activity of [...activities].toSorted(compareThreadActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId =
      typeof payload?.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }
    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

// User-input badges should only light up when the request still has a renderable question set.
export function hasPendingUserInputSignal(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  return derivePendingUserInputSignals(activities).length > 0;
}

export function deriveLatestUserMessageAt(messages: ReadonlyArray<MessageLike>): string | null {
  let latestUserMessageAt: string | null = null;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return latestUserMessageAt;
}

export function findLatestProposedPlanSignal<TPlan extends ProposedPlanLike>(
  proposedPlans: ReadonlyArray<TPlan>,
  latestTurnId: OrchestrationLatestTurn["turnId"] | string | null | undefined,
): TPlan | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((plan) => plan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return matchingTurnPlan;
    }
  }

  return (
    [...proposedPlans]
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1) ?? null
  );
}

export function hasActionableProposedPlanSignal<TPlan extends ProposedPlanLike>(
  proposedPlans: ReadonlyArray<TPlan>,
  latestTurn: Pick<OrchestrationLatestTurn, "turnId"> | null,
): boolean {
  const latestPlan = findLatestProposedPlanSignal(proposedPlans, latestTurn?.turnId ?? null);
  return latestPlan !== null && latestPlan.implementedAt === null;
}
