import {
  CheckpointRef,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applyOrchestrationEvents,
  collapseProjectsExcept,
  markThreadUnread,
  renameProjectLocally,
  reorderProjects,
  setAllProjectsExpanded,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    envMode: "local",
    branch: null,
    worktreePath: null,
    forkSourceThreadId: null,
    handoff: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [makeProject()],
    threads: [thread],
    sidebarThreadSummaryById: {},
    threadsHydrated: true,
  };
}

function makeProject(
  overrides: Partial<AppState["projects"][number]> = {},
): AppState["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    expanded: true,
    scripts: [],
    ...overrides,
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    forkSourceThreadId: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    handoff: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

function makeDomainEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<Extract<OrchestrationEvent, { type: TType }>, "type" | "payload">> = {},
): Extract<OrchestrationEvent, { type: TType }> {
  const aggregateId = "threadId" in payload ? payload.threadId : ProjectId.makeUnsafe("project-1");
  return {
    type,
    payload,
    sequence: overrides.sequence ?? 1,
    eventId: overrides.eventId ?? EventId.makeUnsafe(`event-${crypto.randomUUID()}`),
    aggregateKind: overrides.aggregateKind ?? "thread",
    aggregateId,
    occurredAt: overrides.occurredAt ?? "2026-02-27T00:00:00.000Z",
    commandId: overrides.commandId ?? null,
    causationEventId: overrides.causationEventId ?? null,
    correlationId: overrides.correlationId ?? null,
    metadata: overrides.metadata ?? {},
    ...overrides,
  } as Extract<OrchestrationEvent, { type: TType }>;
}

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
        makeProject({
          id: project3,
          name: "Project 3",
          remoteName: "Project 3",
          folderName: "project-3",
          cwd: "/tmp/project-3",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });

  it("expands every project when toggled on", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
          expanded: false,
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = setAllProjectsExpanded(state, true);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: true },
      { id: project2, expanded: true },
    ]);
  });

  it("collapses all projects when toggled off", () => {
    const state: AppState = {
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = setAllProjectsExpanded(state, false);

    expect(next.projects.every((project) => project.expanded === false)).toBe(true);
  });

  it("collapses every project except the active one", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = collapseProjectsExcept(state, project2);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: false },
      { id: project2, expanded: true },
    ]);
  });

  it("renames a project locally without changing its remote or folder names", () => {
    const state = makeState(makeThread());

    const next = renameProjectLocally(state, ProjectId.makeUnsafe("project-1"), "dpcode");

    expect(next.projects[0]).toMatchObject({
      name: "dpcode",
      localName: "dpcode",
      remoteName: "Project",
      folderName: "project",
    });
  });
});

describe("store read model sync", () => {
  it("filters non-fatal runtime errors from thread banners during read model sync", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError:
            "2026-04-12T23:27:41.094760Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.error).toBeNull();
    expect(next.threads[0]?.session?.lastError).toBeUndefined();
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });

  it("preserves expanded project state when a project briefly disappears from the snapshot", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const initialState: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const snapshotWithoutProject2: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
      ],
      threads: [],
    };
    const snapshotWithProject2Restored: OrchestrationReadModel = {
      snapshotSequence: 3,
      updatedAt: "2026-02-27T00:01:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
      ],
      threads: [],
    };

    const withoutProject2 = syncServerReadModel(initialState, snapshotWithoutProject2);
    const restored = syncServerReadModel(withoutProject2, snapshotWithProject2Restored);

    expect(restored.projects.find((project) => project.id === project2)?.expanded).toBe(true);
  });

  it("preserves a local project alias across read model syncs", () => {
    const aliasedState = renameProjectLocally(
      makeState(makeThread()),
      ProjectId.makeUnsafe("project-1"),
      "dpcode",
    );

    const next = syncServerReadModel(
      aliasedState,
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-28T00:00:00.000Z",
        }),
      ),
    );

    expect(next.projects[0]).toMatchObject({
      name: "dpcode",
      localName: "dpcode",
      remoteName: "Project",
      folderName: "project",
    });
  });

  it("keeps a cleared local project alias from reappearing during syncs", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
      addEventListener: vi.fn(),
    };
    storage.set(
      "t3code:renderer-state:v8",
      JSON.stringify({
        projectNamesByCwd: {
          "/tmp/project": "dpcode",
        },
      }),
    );
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const freshStore = await import("./store");
      const projectId = ProjectId.makeUnsafe("project-1");
      freshStore.useStore.setState((state) => ({
        ...state,
        projects: [
          makeProject({
            id: projectId,
            name: "dpcode",
            localName: "dpcode",
          }),
        ],
        threads: [makeThread()],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      }));

      freshStore.useStore.getState().renameProjectLocally(projectId, null);

      const next = freshStore.syncServerReadModel(
        freshStore.useStore.getState(),
        makeReadModel(
          makeReadModelThread({
            updatedAt: "2026-02-28T00:00:00.000Z",
          }),
        ),
      );

      expect(next.projects[0]).toMatchObject({
        name: "Project",
        localName: null,
        remoteName: "Project",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses unchanged thread objects when the read model timestamp is unchanged", () => {
    const thread = makeThread({
      updatedAt: "2026-02-28T00:00:00.000Z",
      lastVisitedAt: "2026-02-28T00:00:01.000Z",
    });
    const state: AppState = {
      projects: [
        makeProject({
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ],
      threads: [thread],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = syncServerReadModel(state, {
      snapshotSequence: 1,
      updatedAt: "2026-02-28T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ],
      threads: [
        makeReadModelThread({
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt ?? "2026-02-28T00:00:00.000Z",
        }),
      ],
    });

    expect(next.threads[0]).toBe(thread);
  });

  it("uses server-computed sidebar summary signals from the read model", () => {
    const next = syncServerReadModel(
      {
        projects: [],
        threads: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: false,
      },
      makeReadModel(
        makeReadModelThread({
          latestUserMessageAt: "2026-02-27T00:05:00.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          hasActionableProposedPlan: true,
          updatedAt: "2026-02-27T00:10:00.000Z",
        }),
      ),
    );

    expect(next.threads[0]).toMatchObject({
      latestUserMessageAt: "2026-02-27T00:05:00.000Z",
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    });
    expect(next.sidebarThreadSummaryById["thread-1"]).toMatchObject({
      latestUserMessageAt: "2026-02-27T00:05:00.000Z",
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    });
  });
});

describe("live orchestration event application", () => {
  it("merges assistant message chunks and completes the latest turn without waiting for a snapshot", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const messageId = MessageId.makeUnsafe("message-1");
    const initialState = makeState(makeThread());

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "assistant",
        text: "Hel",
        turnId,
        streaming: true,
        source: "native",
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "assistant",
        text: "lo",
        turnId,
        streaming: true,
        source: "native",
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "assistant",
        text: "Hello",
        turnId,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    ]);

    expect(next.threads[0]?.messages).toEqual([
      {
        id: messageId,
        role: "assistant",
        text: "Hello",
        turnId,
        createdAt: "2026-02-27T00:00:01.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        streaming: false,
        source: "native",
      },
    ]);
    expect(next.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "completed",
      requestedAt: "2026-02-27T00:00:01.000Z",
      startedAt: "2026-02-27T00:00:01.000Z",
      completedAt: "2026-02-27T00:00:03.000Z",
      assistantMessageId: messageId,
    });
    expect(next.sidebarThreadSummaryById["thread-1"]?.latestTurn?.state).toBe("completed");
  });

  it("updates latest user message timestamps from live user messages", () => {
    const initialState = makeState(makeThread());

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message-1"),
        role: "user",
        text: "Run this with Claude",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:05:00.000Z",
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    ]);

    expect(next.threads[0]?.latestUserMessageAt).toBe("2026-02-27T00:05:00.000Z");
    expect(next.sidebarThreadSummaryById["thread-1"]?.latestUserMessageAt).toBe(
      "2026-02-27T00:05:00.000Z",
    );
  });

  it("updates pending approval flags from live activity events", () => {
    const initialState = makeState(makeThread());

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: makeActivity({
          id: "approval-open",
          createdAt: "2026-02-27T00:06:00.000Z",
          kind: "approval.requested",
          summary: "Command approval requested",
          tone: "approval",
          payload: {
            requestId: "req-1",
            requestKind: "command",
            detail: "bun run lint",
          },
        }),
      }),
    ]);

    expect(next.threads[0]?.hasPendingApprovals).toBe(true);
    expect(next.sidebarThreadSummaryById["thread-1"]?.hasPendingApprovals).toBe(true);
  });

  it("updates latest turn and thread error immediately from session-set events", () => {
    const turnId = TurnId.makeUnsafe("turn-session-1");
    const initialState = makeState(makeThread());

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: "Turn failed",
          updatedAt: "2026-02-27T00:07:00.000Z",
        },
      }),
    ]);

    expect(next.threads[0]?.session).toMatchObject({
      provider: "claudeAgent",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
    });
    expect(next.threads[0]?.error).toBe("Turn failed");
    expect(next.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "running",
      requestedAt: "2026-02-27T00:07:00.000Z",
      startedAt: "2026-02-27T00:07:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    });
  });

  it("preserves source proposed plan across live turn-start and assistant streaming", () => {
    const turnId = TurnId.makeUnsafe("turn-plan-live-1");
    const messageId = MessageId.makeUnsafe("assistant-plan-live-1");
    const sourceProposedPlan = {
      threadId: ThreadId.makeUnsafe("thread-plan-source"),
      planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
    };
    const initialState = makeState(makeThread());

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message-plan-live-1"),
        createdAt: "2026-02-27T00:07:30.000Z",
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_INTERACTION_MODE,
        sourceProposedPlan,
      }),
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "assistant",
        text: "Applying plan",
        turnId,
        streaming: true,
        source: "native",
        createdAt: "2026-02-27T00:07:31.000Z",
        updatedAt: "2026-02-27T00:07:31.000Z",
      }),
    ]);

    expect(next.threads[0]?.pendingSourceProposedPlan).toEqual(sourceProposedPlan);
    expect(next.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "running",
      requestedAt: "2026-02-27T00:07:31.000Z",
      startedAt: "2026-02-27T00:07:31.000Z",
      completedAt: null,
      assistantMessageId: messageId,
      sourceProposedPlan,
    });
  });

  it("downgrades a stale running latest turn when session-set reports a terminal state", () => {
    const turnId = TurnId.makeUnsafe("turn-session-terminal-1");
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:07:50.000Z",
          startedAt: "2026-02-27T00:07:51.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "error",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "provider crashed",
          updatedAt: "2026-02-27T00:07:55.000Z",
        },
      }),
    ]);

    expect(next.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "error",
      requestedAt: "2026-02-27T00:07:50.000Z",
      startedAt: "2026-02-27T00:07:51.000Z",
      completedAt: "2026-02-27T00:07:55.000Z",
      assistantMessageId: null,
    });
    expect(next.sidebarThreadSummaryById["thread-1"]?.latestTurn?.state).toBe("error");
  });

  it("marks a running turn interrupted as soon as interrupt is requested", () => {
    const turnId = TurnId.makeUnsafe("turn-stop-1");
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:08:00.000Z",
          startedAt: "2026-02-27T00:08:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-interrupt-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        createdAt: "2026-02-27T00:08:05.000Z",
      }),
    ]);

    expect(next.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "interrupted",
      requestedAt: "2026-02-27T00:08:00.000Z",
      startedAt: "2026-02-27T00:08:01.000Z",
      completedAt: "2026-02-27T00:08:05.000Z",
      assistantMessageId: null,
    });
  });

  it("rebinds existing turn diff summaries to the assistant message as soon as it streams in", () => {
    const turnId = TurnId.makeUnsafe("turn-diff-1");
    const messageId = MessageId.makeUnsafe("assistant-message-1");
    const initialState = makeState(
      makeThread({
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:09:00.000Z",
            files: [],
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            checkpointTurnCount: 1,
            status: "completed",
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "assistant",
        text: "Done",
        turnId,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:09:01.000Z",
        updatedAt: "2026-02-27T00:09:01.000Z",
      }),
    ]);

    expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(messageId);
  });

  it("updates latest turn state from a completed turn diff before snapshot reconciliation", () => {
    const turnId = TurnId.makeUnsafe("turn-diff-state-1");
    const sourceProposedPlan = {
      threadId: ThreadId.makeUnsafe("thread-plan-source"),
      planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
    };
    const initialState = makeState(
      makeThread({
        pendingSourceProposedPlan: sourceProposedPlan,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:09:30.000Z",
          startedAt: "2026-02-27T00:09:31.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        completedAt: "2026-02-27T00:09:35.000Z",
        files: [],
        status: "ready",
        assistantMessageId: MessageId.makeUnsafe("assistant-diff-state-1"),
      }),
    ]);

    expect(next.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "completed",
      requestedAt: "2026-02-27T00:09:30.000Z",
      startedAt: "2026-02-27T00:09:31.000Z",
      completedAt: "2026-02-27T00:09:35.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-diff-state-1"),
      sourceProposedPlan,
    });
    expect(next.sidebarThreadSummaryById["thread-1"]?.latestTurn).toEqual({
      turnId,
      state: "completed",
      requestedAt: "2026-02-27T00:09:30.000Z",
      startedAt: "2026-02-27T00:09:31.000Z",
      completedAt: "2026-02-27T00:09:35.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-diff-state-1"),
      sourceProposedPlan,
    });
  });

  it("closes the local session immediately when session-stop-requested arrives", () => {
    const initialState = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-stop-2"),
          createdAt: "2026-02-27T00:10:00.000Z",
          updatedAt: "2026-02-27T00:10:00.000Z",
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-stop-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-27T00:10:05.000Z",
      }),
    ]);

    expect(next.threads[0]?.session).toMatchObject({
      status: "closed",
      orchestrationStatus: "stopped",
      activeTurnId: undefined,
      updatedAt: "2026-02-27T00:10:05.000Z",
    });
  });

  it("prunes optimistic turn state immediately when a thread is reverted", () => {
    const turnId1 = TurnId.makeUnsafe("turn-keep");
    const turnId2 = TurnId.makeUnsafe("turn-drop");
    const initialState = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-keep"),
            role: "user",
            text: "Keep this",
            turnId: turnId1,
            createdAt: "2026-02-27T00:11:00.000Z",
            completedAt: "2026-02-27T00:11:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-keep"),
            role: "assistant",
            text: "Kept answer",
            turnId: turnId1,
            createdAt: "2026-02-27T00:11:01.000Z",
            completedAt: "2026-02-27T00:11:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-drop"),
            role: "user",
            text: "Drop this",
            turnId: turnId2,
            createdAt: "2026-02-27T00:12:00.000Z",
            completedAt: "2026-02-27T00:12:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-drop"),
            role: "assistant",
            text: "Dropped answer",
            turnId: turnId2,
            createdAt: "2026-02-27T00:12:01.000Z",
            completedAt: "2026-02-27T00:12:01.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-keep"),
            turnId: turnId1,
            planMarkdown: "Keep plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:11:00.000Z",
            updatedAt: "2026-02-27T00:11:00.000Z",
          },
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-drop"),
            turnId: turnId2,
            planMarkdown: "Drop plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:12:00.000Z",
            updatedAt: "2026-02-27T00:12:00.000Z",
          },
        ],
        activities: [
          makeActivity({
            id: "activity-keep",
            createdAt: "2026-02-27T00:11:01.500Z",
            turnId: "turn-keep",
          }),
          makeActivity({
            id: "activity-drop",
            createdAt: "2026-02-27T00:12:01.500Z",
            turnId: "turn-drop",
          }),
        ],
        turnDiffSummaries: [
          {
            turnId: turnId1,
            completedAt: "2026-02-27T00:11:02.000Z",
            files: [],
            checkpointTurnCount: 1,
            assistantMessageId: MessageId.makeUnsafe("assistant-keep"),
            status: "completed",
          },
          {
            turnId: turnId2,
            completedAt: "2026-02-27T00:12:02.000Z",
            files: [],
            checkpointTurnCount: 2,
            assistantMessageId: MessageId.makeUnsafe("assistant-drop"),
            status: "completed",
          },
        ],
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-plan-source"),
          planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
        },
        latestTurn: {
          turnId: turnId2,
          state: "running",
          requestedAt: "2026-02-27T00:12:00.000Z",
          startedAt: "2026-02-27T00:12:01.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("assistant-drop"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    ]);

    expect(next.threads[0]?.pendingSourceProposedPlan).toBeUndefined();
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("user-keep"),
      MessageId.makeUnsafe("assistant-keep"),
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual([
      OrchestrationProposedPlanId.makeUnsafe("plan-keep"),
    ]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-keep"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([turnId1]);
    expect(next.threads[0]?.latestTurn).toEqual({
      turnId: turnId1,
      state: "completed",
      requestedAt: "2026-02-27T00:11:02.000Z",
      startedAt: "2026-02-27T00:11:02.000Z",
      completedAt: "2026-02-27T00:11:02.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-keep"),
    });
  });
});
