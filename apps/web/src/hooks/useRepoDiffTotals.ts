// FILE: useRepoDiffTotals.ts
// Purpose: Resolve the working-tree diff totals (+additions / -deletions) for the
//          currently selected repo diff scope. Shared by the chat-header diff toggle
//          badge and the Environment panel "Changes" row so both read the same numbers.
// Layer: Chat git data hook

import { createCachedImport } from "@t3tools/shared/lazyImport";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import { useRepoDiffScopeStore } from "~/repoDiffScopeStore";

type SummarizePatchTotalsFn = typeof import("~/lib/patchParsing").summarizePatchTotals;

// summarizePatchTotals pulls the whole @pierre/diffs parser (the vendor-diffs chunk),
// and this hook sits in the eager chat-route render path. Load the parser on demand —
// once per app session — so the chunk stays out of the initial bundle. After the first
// load every consumer computes totals synchronously again via the module-level cache.
let loadedSummarizePatchTotals: SummarizePatchTotalsFn | null = null;
const loadPatchParsing = createCachedImport(() => import("~/lib/patchParsing"));

const PATCH_PARSING_RETRY_DELAY_MS = 5_000;

export interface RepoDiffTotals {
  additions: number;
  deletions: number;
  /** Number of files touched in the selected scope. */
  fileCount: number;
  /** True when the working tree has any insertions or deletions in the selected scope. */
  hasChanges: boolean;
}

export function useRepoDiffTotals({
  gitCwd,
  isGitRepo,
  refetchInterval = false,
}: {
  gitCwd: string | null;
  isGitRepo: boolean;
  refetchInterval?: number | false;
}): RepoDiffTotals {
  // Match the Diff panel source selector so every surface shows the selected scope.
  const repoDiffScope = useRepoDiffScopeStore((store) => store.scope);
  const { data: selectedRepoDiff = null } = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: gitCwd,
      scope: repoDiffScope,
      enabled: isGitRepo,
      refetchInterval,
    }),
  );
  const [summarizePatchTotals, setSummarizePatchTotals] = useState(
    () => loadedSummarizePatchTotals,
  );
  useEffect(() => {
    if (summarizePatchTotals) {
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      loadPatchParsing().then(
        (module) => {
          loadedSummarizePatchTotals = module.summarizePatchTotals;
          if (!cancelled) {
            setSummarizePatchTotals(() => module.summarizePatchTotals);
          }
        },
        () => {
          // Chunk fetch failed (offline, mid-deploy). createCachedImport already
          // cleared its cache; retry while mounted so the badge heals without a reload.
          if (!cancelled) {
            retryTimer = setTimeout(attempt, PATCH_PARSING_RETRY_DELAY_MS);
          }
        },
      );
    };
    attempt();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
    };
  }, [summarizePatchTotals]);
  // Patch parsing can be noticeable on large diffs; only redo it when the patch text changes.
  const totals = useMemo(
    () => (summarizePatchTotals ? summarizePatchTotals(selectedRepoDiff?.patch) : null),
    [summarizePatchTotals, selectedRepoDiff?.patch],
  );
  const additions = totals?.additions ?? 0;
  const deletions = totals?.deletions ?? 0;
  const fileCount = totals?.fileCount ?? 0;
  return { additions, deletions, fileCount, hasChanges: additions > 0 || deletions > 0 };
}
