// FILE: MemorySearchPanel.tsx
// Purpose: Read-only Search panel — lexical session search via memory.search. When the handshake
//   reports embeddings are available, a small toggle switches to semantic search
//   (memory.searchSemantic); both return the same result shape. Read-only.
// Layer: Web component (Memory)

import { type MemorySearchResult, type ProjectId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { memorySearchQueryOptions, useMemoryStatus } from "~/routes/-memory.shared";
import { formatRelativeTime } from "~/routes/-automations.shared";

import { MemoryListRow } from "./MemoryListRow";
import {
  MemoryPalliumUnavailable,
  MemoryPanelEmpty,
  MemoryPanelError,
  MemoryPanelLoading,
} from "./MemoryPanelStates";

type SearchMode = "lexical" | "semantic";

function resultTitle(result: MemorySearchResult): string {
  if (result.title && result.title.trim().length > 0) {
    return result.title;
  }
  return result.id;
}

function resultDetail(result: MemorySearchResult): string {
  const parts: string[] = [];
  if (result.signals.length > 0) {
    parts.push(result.signals.join(", "));
  } else if (result.gitBranch) {
    parts.push(result.gitBranch);
  } else if (result.cwd) {
    parts.push(result.cwd);
  }
  return parts.join(" · ");
}

export function MemorySearchPanel({ projectId }: { readonly projectId?: ProjectId | null }) {
  const { available, embeddingsEnabled, isLoading: statusLoading } = useMemoryStatus();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("lexical");

  // Semantic search needs embeddings; if they are not available, force lexical so the toggle can't
  // request an empty semantic result set.
  const effectiveMode: SearchMode = embeddingsEnabled ? mode : "lexical";
  const searchQuery = useQuery(
    memorySearchQueryOptions(query, effectiveMode === "semantic", projectId),
  );
  const trimmed = query.trim();

  const submit = () => setQuery(draft);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          onBlur={submit}
          placeholder="Search sessions"
          aria-label="Search sessions"
          className="flex-1"
        />
        {embeddingsEnabled ? (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5 text-xs">
            {(["lexical", "semantic"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  "rounded px-2 py-0.5 capitalize transition-colors",
                  effectiveMode === value
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {statusLoading ? (
        <MemoryPanelLoading label="Loading memory..." />
      ) : !available ? (
        <MemoryPalliumUnavailable />
      ) : trimmed.length === 0 ? (
        <MemoryPanelEmpty
          title="Search your sessions"
          detail="Find past coding sessions by keyword. Enter a query to begin."
        />
      ) : searchQuery.isLoading ? (
        <MemoryPanelLoading label="Searching..." />
      ) : searchQuery.isError ? (
        <MemoryPanelError
          message={
            searchQuery.error instanceof Error
              ? searchQuery.error.message
              : "An unknown error occurred."
          }
        />
      ) : !searchQuery.data || !searchQuery.data.available ? (
        <MemoryPalliumUnavailable />
      ) : searchQuery.data.results.length === 0 ? (
        <MemoryPanelEmpty title="No results" detail={`Nothing matched "${trimmed}".`} />
      ) : (
        <div className="flex flex-col">
          {searchQuery.data.results.map((result) => (
            <MemoryListRow
              key={result.id}
              title={resultTitle(result)}
              detail={resultDetail(result)}
              meta={formatRelativeTime(result.updatedAt ?? result.createdAt ?? null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
