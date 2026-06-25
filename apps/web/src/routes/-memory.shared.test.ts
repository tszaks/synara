// FILE: -memory.shared.test.ts
// Purpose: Logic-level tests for the Memory web surface shared helpers — search-param parsing,
//   tab gating, the attention count, and the query-option factories (keys + enabled gating + the
//   request inputs each queryFn forwards). The web package has no render harness, so these cover
//   the gating + states (unavailable, fixtures, project scoping) at the logic level.
// Layer: Web route shared tests

import { type MemoryOverview, ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isMemoryTab,
  MEMORY_TABS,
  memoryAttentionCount,
  memoryDecisionsQueryOptions,
  memoryFilesQueryOptions,
  memoryOverviewQueryOptions,
  memorySearchQueryOptions,
  memorySessionsQueryOptions,
  memoryStatusQueryOptions,
  parseMemoryRouteSearch,
} from "./-memory.shared";

const memoryApi = {
  status: vi.fn(),
  overview: vi.fn(),
  listFiles: vi.fn(),
  listSessions: vi.fn(),
  listDecisions: vi.fn(),
  search: vi.fn(),
  searchSemantic: vi.fn(),
  index: vi.fn(),
  embedSessions: vi.fn(),
};

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ memory: memoryApi }),
}));

const PROJECT = ProjectId.makeUnsafe("project-1");

beforeEach(() => {
  for (const fn of Object.values(memoryApi)) {
    fn.mockReset();
    fn.mockResolvedValue({ available: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseMemoryRouteSearch", () => {
  it("keeps a known tab and project id", () => {
    expect(parseMemoryRouteSearch({ tab: "files", projectId: "project-1" })).toEqual({
      tab: "files",
      projectId: "project-1",
    });
  });

  it("drops an unknown tab (falls back to default panel)", () => {
    expect(parseMemoryRouteSearch({ tab: "bogus", projectId: "project-1" })).toEqual({
      projectId: "project-1",
    });
  });

  it("drops blank/whitespace values", () => {
    expect(parseMemoryRouteSearch({ tab: "  ", projectId: "   " })).toEqual({});
  });

  it("returns an empty object for no params", () => {
    expect(parseMemoryRouteSearch({})).toEqual({});
  });
});

describe("isMemoryTab", () => {
  it("accepts every declared tab", () => {
    for (const tab of MEMORY_TABS) {
      expect(isMemoryTab(tab.value)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isMemoryTab("nope")).toBe(false);
    expect(isMemoryTab(undefined)).toBe(false);
    expect(isMemoryTab(7)).toBe(false);
  });
});

function overview(partial: Partial<MemoryOverview>): MemoryOverview {
  return {
    available: true,
    indexStatus: "indexed",
    indexed: true,
    workingTreeDirty: false,
    counts: {
      sessions: 0,
      events: 0,
      messages: 0,
      chunks: 0,
      embeddings: 0,
      workingTreeFiles: 0,
    },
    embeddingModels: [],
    embeddingBacklog: 0,
    ...partial,
  };
}

describe("memoryAttentionCount", () => {
  it("is zero when Pallium is unavailable", () => {
    expect(memoryAttentionCount(overview({ available: false, embeddingBacklog: 5 }))).toBe(0);
    expect(memoryAttentionCount(null)).toBe(0);
    expect(memoryAttentionCount(undefined)).toBe(0);
  });

  it("counts embedding backlog and a dirty working tree", () => {
    expect(memoryAttentionCount(overview({}))).toBe(0);
    expect(memoryAttentionCount(overview({ embeddingBacklog: 3 }))).toBe(1);
    expect(memoryAttentionCount(overview({ workingTreeDirty: true }))).toBe(1);
    expect(memoryAttentionCount(overview({ embeddingBacklog: 3, workingTreeDirty: true }))).toBe(2);
  });
});

describe("query-option factories", () => {
  it("scopes overview/files/sessions keys by project id", () => {
    expect(memoryStatusQueryOptions().queryKey).toEqual(["memory", "status"]);
    expect(memoryOverviewQueryOptions(PROJECT).queryKey).toEqual([
      "memory",
      "overview",
      "project-1",
    ]);
    expect(memoryFilesQueryOptions(null).queryKey).toEqual(["memory", "files", null]);
    expect(memorySessionsQueryOptions(PROJECT).queryKey).toEqual([
      "memory",
      "sessions",
      "project-1",
    ]);
  });

  it("forwards the project id into overview/files/sessions inputs, omitting it when absent", async () => {
    await memoryOverviewQueryOptions(PROJECT).queryFn?.({} as never);
    expect(memoryApi.overview).toHaveBeenCalledWith({ projectId: "project-1" });

    await memoryOverviewQueryOptions(null).queryFn?.({} as never);
    expect(memoryApi.overview).toHaveBeenLastCalledWith({});

    await memoryFilesQueryOptions(PROJECT).queryFn?.({} as never);
    expect(memoryApi.listFiles).toHaveBeenCalledWith({ projectId: "project-1" });

    await memorySessionsQueryOptions(null).queryFn?.({} as never);
    expect(memoryApi.listSessions).toHaveBeenCalledWith({});
  });

  it("only enables decisions/search once a non-empty query is entered", () => {
    expect(memoryDecisionsQueryOptions("", PROJECT).enabled).toBe(false);
    expect(memoryDecisionsQueryOptions("   ", PROJECT).enabled).toBe(false);
    expect(memoryDecisionsQueryOptions("paywall", PROJECT).enabled).toBe(true);

    expect(memorySearchQueryOptions("", false, PROJECT).enabled).toBe(false);
    expect(memorySearchQueryOptions("auth", false, PROJECT).enabled).toBe(true);
  });

  it("trims the decisions query and forwards it (plus project) to listDecisions", async () => {
    await memoryDecisionsQueryOptions("  why drop  ", PROJECT).queryFn?.({} as never);
    expect(memoryApi.listDecisions).toHaveBeenCalledWith({
      query: "why drop",
      projectId: "project-1",
    });
  });

  it("routes search to the lexical vs semantic backend by the semantic flag", async () => {
    await memorySearchQueryOptions("retry logic", false, null).queryFn?.({} as never);
    expect(memoryApi.search).toHaveBeenCalledWith({ query: "retry logic" });
    expect(memoryApi.searchSemantic).not.toHaveBeenCalled();

    await memorySearchQueryOptions("retry logic", true, PROJECT).queryFn?.({} as never);
    expect(memoryApi.searchSemantic).toHaveBeenCalledWith({
      query: "retry logic",
      projectId: "project-1",
    });
  });
});
