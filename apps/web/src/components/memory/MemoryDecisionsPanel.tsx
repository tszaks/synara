// FILE: MemoryDecisionsPanel.tsx
// Purpose: Read-only Decisions panel — decision notes from memory.listDecisions. Pallium requires
//   a query (no "list all" mode — contracts gap A), so this panel includes a small query input and
//   only fetches once a non-empty query is entered.
// Layer: Web component (Memory)

import { type ProjectId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Input } from "~/components/ui/input";
import { memoryDecisionsQueryOptions, useMemoryStatus } from "~/routes/-memory.shared";
import { formatRelativeTime } from "~/routes/-automations.shared";

import {
  MemoryPalliumUnavailable,
  MemoryPanelEmpty,
  MemoryPanelError,
  MemoryPanelLoading,
} from "./MemoryPanelStates";

export function MemoryDecisionsPanel({ projectId }: { readonly projectId?: ProjectId | null }) {
  const { available, isLoading: statusLoading } = useMemoryStatus();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  const decisionsQuery = useQuery(memoryDecisionsQueryOptions(query, projectId));
  const trimmed = query.trim();

  const submit = () => setQuery(draft);

  return (
    <div className="flex flex-col gap-4">
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
        placeholder="Search decision notes (e.g. why did we drop the paywall)"
        aria-label="Search decision notes"
      />
      {statusLoading ? (
        <MemoryPanelLoading label="Loading memory..." />
      ) : !available ? (
        <MemoryPalliumUnavailable />
      ) : trimmed.length === 0 ? (
        <MemoryPanelEmpty
          title="Search decisions"
          detail="Decisions are searchable, not browsable. Enter a query to find matching notes."
        />
      ) : decisionsQuery.isLoading ? (
        <MemoryPanelLoading label="Searching..." />
      ) : decisionsQuery.isError ? (
        <MemoryPanelError
          message={
            decisionsQuery.error instanceof Error
              ? decisionsQuery.error.message
              : "An unknown error occurred."
          }
        />
      ) : !decisionsQuery.data || !decisionsQuery.data.available ? (
        <MemoryPalliumUnavailable />
      ) : decisionsQuery.data.decisions.length === 0 ? (
        <MemoryPanelEmpty title="No matching decisions" detail={`Nothing matched "${trimmed}".`} />
      ) : (
        <div className="flex flex-col gap-3">
          {decisionsQuery.data.decisions.map((decision) => (
            <article
              key={`${decision.sourceType ?? ""}:${decision.sourceRef ?? ""}:${decision.committedAt ?? ""}:${decision.title ?? ""}`}
              className="flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="min-w-0 truncate text-[0.8125rem] font-medium text-foreground">
                  {decision.title ?? decision.sourceRef ?? "Decision"}
                </h3>
                {decision.committedAt ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatRelativeTime(decision.committedAt)}
                  </span>
                ) : null}
              </div>
              {decision.body ? (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {decision.body}
                </p>
              ) : null}
              {decision.sourceType || decision.sourceRef ? (
                <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">
                  {[decision.sourceType, decision.sourceRef].filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
