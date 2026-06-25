// FILE: MemorySessionsPanel.tsx
// Purpose: Read-only Sessions panel — recent stored coding sessions from memory.listSessions.
//   Read-only; mirrors the Automations list row layout.
// Layer: Web component (Memory)

import { type MemorySession, type ProjectId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { memorySessionsQueryOptions } from "~/routes/-memory.shared";
import { formatRelativeTime } from "~/routes/-automations.shared";

import { MemoryListRow } from "./MemoryListRow";
import {
  MemoryPalliumUnavailable,
  MemoryPanelEmpty,
  MemoryPanelError,
  MemoryPanelLoading,
} from "./MemoryPanelStates";

function sessionTitle(session: MemorySession): string {
  if (session.title && session.title.trim().length > 0) {
    return session.title;
  }
  return session.id;
}

function sessionDetail(session: MemorySession): string {
  const parts: string[] = [];
  if (session.model) {
    parts.push(session.modelProvider ? `${session.modelProvider}/${session.model}` : session.model);
  } else if (session.modelProvider) {
    parts.push(session.modelProvider);
  }
  if (session.gitBranch) {
    parts.push(session.gitBranch);
  }
  if (session.cwd) {
    parts.push(session.cwd);
  }
  return parts.join(" · ");
}

export function MemorySessionsPanel({ projectId }: { readonly projectId?: ProjectId | null }) {
  const sessionsQuery = useQuery(memorySessionsQueryOptions(projectId));

  if (sessionsQuery.isLoading) {
    return <MemoryPanelLoading label="Loading sessions..." />;
  }
  if (sessionsQuery.isError) {
    return (
      <MemoryPanelError
        message={
          sessionsQuery.error instanceof Error
            ? sessionsQuery.error.message
            : "An unknown error occurred."
        }
      />
    );
  }

  const result = sessionsQuery.data ?? null;
  if (!result || !result.available) {
    return <MemoryPalliumUnavailable />;
  }
  if (result.sessions.length === 0) {
    return (
      <MemoryPanelEmpty
        title="No sessions yet"
        detail="Coding sessions appear here once Pallium has captured some."
      />
    );
  }

  return (
    <div className="flex flex-col">
      {result.sessions.map((session) => (
        <MemoryListRow
          key={session.id}
          title={sessionTitle(session)}
          detail={sessionDetail(session)}
          meta={formatRelativeTime(session.updatedAt ?? session.createdAt ?? null)}
        />
      ))}
    </div>
  );
}
