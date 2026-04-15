// FILE: threadSignals.test.ts
// Purpose: Covers shared thread signal helpers used by both snapshot projection and live web state.
// Exports: Vitest coverage for pending-request badges, latest user timestamps, and proposed-plan actionability.

import { describe, expect, it } from "vitest";
import {
  EventId,
  OrchestrationProposedPlanId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  compareThreadActivitiesByOrder,
  derivePendingApprovalSignals,
  deriveLatestUserMessageAt,
  hasActionableProposedPlanSignal,
  hasPendingApprovalsSignal,
  hasPendingUserInputSignal,
} from "./threadSignals";

function makeActivity(
  overrides: Partial<OrchestrationThreadActivity> & { kind: OrchestrationThreadActivity["kind"] },
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-27T00:00:00.000Z",
    kind: overrides.kind,
    summary: overrides.summary ?? overrides.kind,
    tone: overrides.tone ?? "info",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ?? null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("threadSignals", () => {
  it("derives the latest user message timestamp", () => {
    expect(
      deriveLatestUserMessageAt([
        { role: "assistant", createdAt: "2026-02-27T00:00:01.000Z" },
        { role: "user", createdAt: "2026-02-27T00:00:02.000Z" },
        { role: "user", createdAt: "2026-02-27T00:00:03.000Z" },
      ]),
    ).toBe("2026-02-27T00:00:03.000Z");
  });

  it("ignores malformed approval requests when computing pending approval badges", () => {
    expect(
      hasPendingApprovalsSignal([
        makeActivity({
          kind: "approval.requested",
          payload: {
            requestId: "req-invalid",
          },
        }),
      ]),
    ).toBe(false);

    expect(
      hasPendingApprovalsSignal([
        makeActivity({
          kind: "approval.requested",
          payload: {
            requestId: "req-valid",
            requestType: "exec_command_approval",
          },
        }),
      ]),
    ).toBe(true);
  });

  it("keeps pending approval ordering aligned with activity sequence", () => {
    const approvals = derivePendingApprovalSignals([
      makeActivity({
        id: EventId.makeUnsafe("approval-resolved"),
        kind: "approval.resolved",
        sequence: 2,
        payload: { requestId: "req-sequenced" },
      }),
      makeActivity({
        id: EventId.makeUnsafe("approval-open"),
        kind: "approval.requested",
        sequence: 1,
        payload: {
          requestId: "req-sequenced",
          requestType: "exec_command_approval",
        },
      }),
    ]);

    expect(approvals).toHaveLength(0);
    expect(
      [2, 1]
        .map((sequence) =>
          makeActivity({
            id: EventId.makeUnsafe(`approval-order-${sequence}`),
            kind: "approval.requested",
            sequence,
            payload: {
              requestId: `req-order-${sequence}`,
              requestType: "exec_command_approval",
            },
          }),
        )
        .toSorted(compareThreadActivitiesByOrder)
        .map((activity) => activity.sequence),
    ).toEqual([1, 2]);
  });

  it("only marks pending user input when the questions payload is renderable", () => {
    expect(
      hasPendingUserInputSignal([
        makeActivity({
          kind: "user-input.requested",
          payload: {
            requestId: "user-input-invalid",
            questions: [{ id: "q1" }],
          },
        }),
      ]),
    ).toBe(false);

    expect(
      hasPendingUserInputSignal([
        makeActivity({
          kind: "user-input.requested",
          payload: {
            requestId: "user-input-valid",
            questions: [
              {
                id: "q1",
                header: "Need input",
                question: "Choose one",
                options: [{ label: "A", description: "First option" }],
              },
            ],
          },
        }),
      ]),
    ).toBe(true);
  });

  it("prefers the latest plan for the active turn when deciding actionability", () => {
    expect(
      hasActionableProposedPlanSignal(
        [
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-latest-other"),
            turnId: TurnId.makeUnsafe("turn-other"),
            updatedAt: "2026-02-27T00:00:04.000Z",
            implementedAt: "2026-02-27T00:00:05.000Z",
          },
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-active"),
            turnId: TurnId.makeUnsafe("turn-active"),
            updatedAt: "2026-02-27T00:00:03.000Z",
            implementedAt: null,
          },
        ],
        { turnId: TurnId.makeUnsafe("turn-active") },
      ),
    ).toBe(true);

    expect(
      hasActionableProposedPlanSignal(
        [
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-done"),
            turnId: TurnId.makeUnsafe("turn-active"),
            updatedAt: "2026-02-27T00:00:03.000Z",
            implementedAt: "2026-02-27T00:00:06.000Z",
          },
        ],
        { turnId: TurnId.makeUnsafe("turn-active") },
      ),
    ).toBe(false);
  });
});
