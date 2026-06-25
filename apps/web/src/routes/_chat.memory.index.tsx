import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { MemoryDecisionsPanel } from "~/components/memory/MemoryDecisionsPanel";
import { MemoryFilesPanel } from "~/components/memory/MemoryFilesPanel";
import { MemoryOverviewPanel } from "~/components/memory/MemoryOverview";
import {
  MemoryPalliumUnavailable,
  MemoryPanelLoading,
} from "~/components/memory/MemoryPanelStates";
import { MemorySearchPanel } from "~/components/memory/MemorySearchPanel";
import { MemorySessionsPanel } from "~/components/memory/MemorySessionsPanel";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import {
  MEMORY_TABS,
  parseMemoryRouteSearch,
  useMemoryStatus,
  type MemoryTab,
} from "./-memory.shared";

export const Route = createFileRoute("/_chat/memory/")({
  validateSearch: (search) => parseMemoryRouteSearch(search),
  component: MemoryRouteView,
});

function MemoryRouteView() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const { available, isLoading } = useMemoryStatus();

  const activeTab: MemoryTab = search.tab ?? "overview";
  const projectId = search.projectId ?? null;

  const selectTab = (tab: MemoryTab) =>
    void navigate({
      to: "/memory",
      search: (prev) => ({ ...prev, tab }),
    });

  return (
    <SidebarInset
      className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME}
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="min-w-0 flex-1" />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-12 pt-8">
            <h1 className="px-2 font-heading text-2xl font-semibold tracking-tight text-foreground">
              Memory
            </h1>

            {isLoading ? (
              <MemoryPanelLoading label="Loading memory..." />
            ) : !available ? (
              <MemoryPalliumUnavailable />
            ) : (
              <>
                <div className="flex w-fit items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5 text-xs">
                  {MEMORY_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => selectTab(tab.value)}
                      className={cn(
                        "rounded px-3 py-1 transition-colors",
                        activeTab === tab.value
                          ? "bg-background text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="px-2">
                  {activeTab === "overview" ? (
                    <MemoryOverviewPanel projectId={projectId} />
                  ) : activeTab === "files" ? (
                    <MemoryFilesPanel projectId={projectId} />
                  ) : activeTab === "sessions" ? (
                    <MemorySessionsPanel projectId={projectId} />
                  ) : activeTab === "decisions" ? (
                    <MemoryDecisionsPanel projectId={projectId} />
                  ) : (
                    <MemorySearchPanel projectId={projectId} />
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}
