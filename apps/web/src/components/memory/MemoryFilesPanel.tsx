// FILE: MemoryFilesPanel.tsx
// Purpose: Read-only Files panel — the working tree's changed files from memory.listFiles, with
//   each file's path, git status, and Pallium risk band. Read-only; mirrors the Automations list.
// Layer: Web component (Memory)

import { type ProjectId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { cn } from "~/lib/utils";
import { memoryFilesQueryOptions } from "~/routes/-memory.shared";

import { MemoryListRow } from "./MemoryListRow";
import {
  MemoryPalliumUnavailable,
  MemoryPanelEmpty,
  MemoryPanelError,
  MemoryPanelLoading,
} from "./MemoryPanelStates";

// Risk band → dot color. Unknown bands fall back to a quiet dot so a new Pallium band can't break.
function riskDotClassName(riskLevel: string): string {
  switch (riskLevel.toLowerCase()) {
    case "high":
      return "text-destructive";
    case "medium":
      return "text-amber-500";
    case "low":
      return "text-emerald-500";
    default:
      return "text-muted-foreground/50";
  }
}

export function MemoryFilesPanel({ projectId }: { readonly projectId?: ProjectId | null }) {
  const filesQuery = useQuery(memoryFilesQueryOptions(projectId));

  if (filesQuery.isLoading) {
    return <MemoryPanelLoading label="Loading files..." />;
  }
  if (filesQuery.isError) {
    return (
      <MemoryPanelError
        message={
          filesQuery.error instanceof Error
            ? filesQuery.error.message
            : "An unknown error occurred."
        }
      />
    );
  }

  const result = filesQuery.data ?? null;
  if (!result || !result.available) {
    return <MemoryPalliumUnavailable />;
  }
  if (!projectId) {
    return (
      <MemoryPanelEmpty
        title="No project selected"
        detail="Open Memory from a project to see its changed files and their risk."
      />
    );
  }
  if (result.files.length === 0) {
    return (
      <MemoryPanelEmpty
        title="No changed files"
        detail="The working tree is clean, so there is nothing to assess right now."
      />
    );
  }

  return (
    <div className="flex flex-col">
      {result.files.map((file) => (
        <MemoryListRow
          key={file.path}
          leading={
            <span
              className={cn(
                "flex size-3.5 shrink-0 items-center justify-center",
                riskDotClassName(file.riskLevel),
              )}
              title={`Risk: ${file.riskLevel}`}
            >
              <span className="block size-1.5 rounded-full bg-current" />
            </span>
          }
          title={file.path}
          detail={file.workingTreeStatus}
          meta={file.riskLevel}
        />
      ))}
    </div>
  );
}
