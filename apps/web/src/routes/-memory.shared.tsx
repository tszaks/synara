// FILE: -memory.shared.tsx
// Purpose: Shared data-fetching hook, query-option factories, and small helpers for the
//   read-only Memory web surface (Pallium-backed). Mirrors -automations.shared.tsx so the
//   Memory routes/panels fetch and render the same way the Automations surface does.
// Layer: Web route shared logic

import {
  type MemoryDecisionList,
  type MemoryFileList,
  type MemoryListDecisionsInput,
  type MemoryOverview,
  type MemorySearchInput,
  type MemorySearchResultList,
  type MemorySearchSemanticInput,
  type MemorySessionList,
  type MemoryStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

// All Memory queries hang off this root key so a future live-event reducer (later PR) can
// invalidate the whole surface in one call, the same way ["automations"] does.
export const memoryQueryKeys = {
  all: ["memory"] as const,
  status: () => ["memory", "status"] as const,
  overview: (projectId?: ProjectId | null) => ["memory", "overview", projectId ?? null] as const,
  files: (projectId?: ProjectId | null) => ["memory", "files", projectId ?? null] as const,
  sessions: (projectId?: ProjectId | null) => ["memory", "sessions", projectId ?? null] as const,
  decisions: (query: string, projectId?: ProjectId | null) =>
    ["memory", "decisions", projectId ?? null, query] as const,
  search: (query: string, semantic: boolean, projectId?: ProjectId | null) =>
    ["memory", "search", semantic ? "semantic" : "lexical", projectId ?? null, query] as const,
};

export function memoryStatusQueryOptions() {
  return queryOptions({
    queryKey: memoryQueryKeys.status(),
    queryFn: (): Promise<MemoryStatus> => ensureNativeApi().memory.status(),
  });
}

export function memoryOverviewQueryOptions(projectId?: ProjectId | null) {
  return queryOptions({
    queryKey: memoryQueryKeys.overview(projectId),
    queryFn: (): Promise<MemoryOverview> =>
      ensureNativeApi().memory.overview(projectId ? { projectId } : {}),
  });
}

export function memoryFilesQueryOptions(projectId?: ProjectId | null) {
  return queryOptions({
    queryKey: memoryQueryKeys.files(projectId),
    queryFn: (): Promise<MemoryFileList> =>
      ensureNativeApi().memory.listFiles(projectId ? { projectId } : {}),
  });
}

export function memorySessionsQueryOptions(projectId?: ProjectId | null) {
  return queryOptions({
    queryKey: memoryQueryKeys.sessions(projectId),
    queryFn: (): Promise<MemorySessionList> =>
      ensureNativeApi().memory.listSessions(projectId ? { projectId } : {}),
  });
}

// Decisions REQUIRE a query (Pallium has no "list all" mode — see contracts gap A), so the
// query is only enabled once the caller has a non-empty trimmed query.
export function memoryDecisionsQueryOptions(query: string, projectId?: ProjectId | null) {
  const trimmed = query.trim();
  const input: MemoryListDecisionsInput = projectId
    ? { query: trimmed, projectId }
    : { query: trimmed };
  return queryOptions({
    queryKey: memoryQueryKeys.decisions(trimmed, projectId),
    queryFn: (): Promise<MemoryDecisionList> => ensureNativeApi().memory.listDecisions(input),
    enabled: trimmed.length > 0,
  });
}

// Search also requires a query. `semantic` toggles between the lexical (`search`) and vector
// (`searchSemantic`) backends; both return the same MemorySearchResultList shape.
export function memorySearchQueryOptions(
  query: string,
  semantic: boolean,
  projectId?: ProjectId | null,
) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: memoryQueryKeys.search(trimmed, semantic, projectId),
    queryFn: (): Promise<MemorySearchResultList> => {
      const api = ensureNativeApi();
      if (semantic) {
        const input: MemorySearchSemanticInput = projectId
          ? { query: trimmed, projectId }
          : { query: trimmed };
        return api.memory.searchSemantic(input);
      }
      const input: MemorySearchInput = projectId
        ? { query: trimmed, projectId }
        : { query: trimmed };
      return api.memory.search(input);
    },
    enabled: trimmed.length > 0,
  });
}

/**
 * Lightweight handshake hook. Returns the gating status plus convenience booleans the routes
 * and Sidebar read to decide whether to show the Memory surface at all (when Pallium is
 * absent, `available` is false and the feature stays hidden, so Synara looks as it does today).
 */
export function useMemoryStatus() {
  const statusQuery = useQuery(memoryStatusQueryOptions());
  const status = statusQuery.data ?? null;
  return {
    status,
    isLoading: statusQuery.isLoading,
    available: status?.available === true,
    embeddingsEnabled: status?.capabilities.embeddings === true,
  };
}

/**
 * Per-project overview hook. Disabled until the handshake reports `available`, so we never spawn
 * a Pallium child for the overview when the binary is absent.
 */
export function useMemory(projectId?: ProjectId | null) {
  const { status, available, embeddingsEnabled, isLoading: statusLoading } = useMemoryStatus();
  const overviewQuery = useQuery({
    ...memoryOverviewQueryOptions(projectId),
    enabled: available,
  });
  return {
    status,
    available,
    embeddingsEnabled,
    isStatusLoading: statusLoading,
    overview: overviewQuery.data ?? null,
    isOverviewLoading: overviewQuery.isLoading,
    refetchOverview: overviewQuery.refetch,
  };
}

export type MemoryTab = "overview" | "files" | "sessions" | "decisions" | "search";

export const MEMORY_TABS: readonly { readonly value: MemoryTab; readonly label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "files", label: "Files" },
  { value: "sessions", label: "Sessions" },
  { value: "decisions", label: "Decisions" },
  { value: "search", label: "Search" },
];

const MEMORY_TAB_VALUES = new Set<MemoryTab>(MEMORY_TABS.map((tab) => tab.value));

export function isMemoryTab(value: unknown): value is MemoryTab {
  return typeof value === "string" && MEMORY_TAB_VALUES.has(value as MemoryTab);
}

export interface MemoryRouteSearch {
  tab?: MemoryTab | undefined;
  projectId?: ProjectId | undefined;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalizes the Memory route's URL search state: an optional segmented `tab` and an optional
 * `projectId` scope. Unknown tabs fall back to the default panel (omitted = Overview) and blank
 * project ids are dropped, mirroring parseDiffRouteSearch's defensive normalization.
 */
export function parseMemoryRouteSearch(search: Record<string, unknown>): MemoryRouteSearch {
  const tabRaw = normalizeSearchString(search.tab);
  const tab = isMemoryTab(tabRaw) ? tabRaw : undefined;
  const projectIdRaw = normalizeSearchString(search.projectId);
  return {
    ...(tab ? { tab } : {}),
    ...(projectIdRaw ? { projectId: projectIdRaw as ProjectId } : {}),
  };
}

/**
 * The "needs setup / attention" count for the Memory surface, mirroring automationAttentionCount.
 * Surfaces a single badge when the project is indexed but has an embedding backlog OR a dirty
 * working tree (both signal "memory is out of date"). Zero when Pallium is unavailable.
 */
export function memoryAttentionCount(overview: MemoryOverview | null | undefined): number {
  if (!overview || !overview.available) {
    return 0;
  }
  let count = 0;
  if (overview.embeddingBacklog > 0) {
    count += 1;
  }
  if (overview.workingTreeDirty) {
    count += 1;
  }
  return count;
}
