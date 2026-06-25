// FILE: MemoryOverview.tsx
// Purpose: Read-only Memory overview panel — index freshness, repo health, counts, and the
//   embedding backlog from memory.overview. Mirrors the Automations detail "DetailGroup/DetailRow"
//   layout so the two surfaces read identically.
// Layer: Web component (Memory)

import { type MemoryOverview, type ProjectId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { memoryOverviewQueryOptions } from "~/routes/-memory.shared";
import { formatRelativeTime } from "~/routes/-automations.shared";

import {
  MemoryPalliumUnavailable,
  MemoryPanelEmpty,
  MemoryPanelError,
  MemoryPanelLoading,
} from "./MemoryPanelStates";

function indexStatusDisplay(overview: MemoryOverview): {
  readonly label: string;
  readonly dotClassName: string;
} {
  if (!overview.indexed) {
    return { label: "Not indexed", dotClassName: "bg-muted-foreground/50" };
  }
  if (overview.workingTreeDirty) {
    return { label: "Stale (uncommitted changes)", dotClassName: "bg-amber-500" };
  }
  return { label: "Indexed", dotClassName: "bg-emerald-500" };
}

export function MemoryOverviewPanel({ projectId }: { readonly projectId?: ProjectId | null }) {
  const overviewQuery = useQuery(memoryOverviewQueryOptions(projectId));

  if (overviewQuery.isLoading) {
    return <MemoryPanelLoading label="Loading overview..." />;
  }
  if (overviewQuery.isError) {
    return (
      <MemoryPanelError
        message={
          overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "An unknown error occurred."
        }
      />
    );
  }

  const overview = overviewQuery.data ?? null;
  if (!overview || !overview.available) {
    return <MemoryPalliumUnavailable />;
  }
  if (!projectId) {
    return (
      <MemoryPanelEmpty
        title="No project selected"
        detail="Open Memory from a project to see its index freshness, counts, and embedding backlog."
      />
    );
  }

  const status = indexStatusDisplay(overview);

  return (
    <div className="flex flex-col gap-6">
      <DetailGroup title="Index">
        <DetailRow label="Status">
          <StatusValue>
            <span className={cn("size-1.5 rounded-full", status.dotClassName)} />
            {status.label}
          </StatusValue>
        </DetailRow>
        <DetailRow label="Last indexed">
          {overview.lastIndexedAt ? (
            <StatusValue tone="muted">{formatRelativeTime(overview.lastIndexedAt)}</StatusValue>
          ) : (
            "—"
          )}
        </DetailRow>
        <DetailRow label="Indexed commit">
          {overview.lastIndexedCommit ? (
            <StatusValue tone="muted">{overview.lastIndexedCommit.slice(0, 12)}</StatusValue>
          ) : (
            "—"
          )}
        </DetailRow>
        <DetailRow label="Working tree">
          <StatusValue tone="muted">{overview.workingTreeDirty ? "Dirty" : "Clean"}</StatusValue>
        </DetailRow>
        <DetailRow label="Uncommitted files">
          <StatusValue tone="muted">{overview.counts.workingTreeFiles}</StatusValue>
        </DetailRow>
      </DetailGroup>

      <DetailGroup title="Counts">
        <DetailRow label="Sessions">
          <StatusValue tone="muted">{overview.counts.sessions}</StatusValue>
        </DetailRow>
        <DetailRow label="Events">
          <StatusValue tone="muted">{overview.counts.events}</StatusValue>
        </DetailRow>
        <DetailRow label="Messages">
          <StatusValue tone="muted">{overview.counts.messages}</StatusValue>
        </DetailRow>
        <DetailRow label="Chunks">
          <StatusValue tone="muted">{overview.counts.chunks}</StatusValue>
        </DetailRow>
        <DetailRow label="Embeddings">
          <StatusValue tone="muted">{overview.counts.embeddings}</StatusValue>
        </DetailRow>
      </DetailGroup>

      <DetailGroup title="Embeddings">
        <DetailRow label="Backlog">
          <StatusValue tone={overview.embeddingBacklog > 0 ? "default" : "muted"}>
            {overview.embeddingBacklog > 0
              ? `${overview.embeddingBacklog} not embedded`
              : "Up to date"}
          </StatusValue>
        </DetailRow>
        {overview.embeddingModels.length === 0 ? (
          <DetailRow label="Models">
            <StatusValue tone="muted">None</StatusValue>
          </DetailRow>
        ) : (
          overview.embeddingModels.map((model) => (
            <DetailRow key={`${model.provider}:${model.model}`} label={`${model.provider}`}>
              <StatusValue tone="muted">
                {model.model} · {model.count}
              </StatusValue>
            </DetailRow>
          ))
        )}
      </DetailGroup>
    </div>
  );
}

function DetailGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-0.5">
      <h2 className="px-1.5 pb-1 text-xs font-medium text-muted-foreground/70">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-xs">
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  );
}

function StatusValue({
  tone = "default",
  children,
}: {
  readonly tone?: "default" | "muted";
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </span>
  );
}
