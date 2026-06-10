// FILE: sidebar/threadRowShared.tsx
// Purpose: Shared types and small presentational components for sidebar thread rows.

import { type ReactNode } from "react";
import { pluralize } from "@t3tools/shared/text";
import { type ProviderKind, type GitStatusResult } from "@t3tools/contracts";
import { type LucideIcon } from "~/lib/icons";
import { GitMergedSimpleIcon, GitPullRequestIcon, TerminalIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SidebarGlyph, sidebarGlyphClass } from "../sidebarGlyphs";
import { ProviderIcon } from "../ProviderIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HiOutlineCheckCircle } from "react-icons/hi2";
import { ThreadRunningSpinner } from "../ThreadRunningSpinner";
import type { Thread } from "../../types";
import { resolveThreadEnvironmentPresentation } from "../../lib/threadEnvironment";
import { resolveThreadHandoffBadgeLabel } from "../../lib/threadHandoff";
import { GoRepoForked } from "react-icons/go";
import { FiGitBranch } from "react-icons/fi";
import { LuSplit } from "react-icons/lu";
import type { ThreadStatusPill } from "../Sidebar.logic";

export type { ThreadStatusPill };

// ---- Types ----

export interface TerminalStatusIndicator {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  icon: LucideIcon;
  tooltip: string;
  url: string;
}

export type ThreadPr = GitStatusResult["pr"];

export type ThreadMetaChip = {
  id: "handoff" | "fork" | "worktree";
  tooltip: string;
  icon: ReactNode;
};

// ---- Constants ----

export const THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME =
  "flex shrink-0 items-center transition-opacity group-hover/thread-row:pointer-events-none group-hover/thread-row:opacity-0 group-focus-within/thread-row:pointer-events-none group-focus-within/thread-row:opacity-0";

export const EMPTY_SHORTCUT_PARTS: readonly string[] = [];

// ---- Helpers ----

export function terminalStatusFromThreadState(input: {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
}): TerminalStatusIndicator | null {
  const terminalAttentionStates = Object.values(input.terminalAttentionStatesById ?? {});
  if (terminalAttentionStates.includes("attention")) {
    return {
      label: "Terminal input needed",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      pulse: false,
    };
  }
  if ((input.runningTerminalIds?.length ?? 0) > 0) {
    return {
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    };
  }
  if (terminalAttentionStates.includes("review")) {
    return {
      label: "Terminal task completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      pulse: false,
    };
  }
  return null;
}

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;
  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-[var(--color-decoration-added)]",
      icon: GitPullRequestIcon,
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      icon: GitPullRequestIcon,
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-500 dark:text-violet-400",
      icon: GitMergedSimpleIcon,
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function resolveWorktreeBadgeLabel(
  thread: Pick<Thread, "envMode" | "worktreePath">,
): string | null {
  return resolveThreadEnvironmentPresentation({
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  }).worktreeBadgeLabel;
}

export function resolveThreadRowMetaChips(input: {
  thread: Pick<
    Thread,
    "forkSourceThreadId" | "sidechatSourceThreadId" | "envMode" | "worktreePath" | "handoff"
  >;
  includeHandoffBadge: boolean;
  handoffShownInAvatar?: boolean;
}): ThreadMetaChip[] {
  const chips: ThreadMetaChip[] = [];
  const isSidechatThread = Boolean(input.thread.sidechatSourceThreadId);

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && !input.handoffShownInAvatar && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: <SidebarGlyph icon={FiGitBranch} variant="meta" className="text-muted-foreground/55" />,
    });
  }

  if (input.thread.forkSourceThreadId && !isSidechatThread) {
    chips.push({
      id: "fork",
      tooltip: "Forked thread",
      icon: (
        <SidebarGlyph
          icon={GoRepoForked}
          variant="meta"
          className="text-emerald-600 dark:text-emerald-300/90"
        />
      ),
    });
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: (
        <LuSplit
          aria-hidden="true"
          className={cn("rotate-90", sidebarGlyphClass("meta", "text-muted-foreground/55"))}
        />
      ),
    });
  }

  return chips;
}

export function threadRowTimestampSlotClassName(
  isSubagentThread: boolean,
  toneClassName?: string,
): string {
  return cn(
    "mr-1 flex shrink-0 items-center justify-end leading-none tabular-nums transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
    isSubagentThread
      ? "w-[1.2rem] text-[10px]"
      : "w-[1.625rem] text-[length:var(--app-font-size-ui-meta,11px)]",
    toneClassName ?? (isSubagentThread ? "text-muted-foreground/26" : "text-muted-foreground/38"),
  );
}

// ---- Small Components ----

export function ThreadStatusTrailingGlyph({ threadStatus }: { threadStatus: ThreadStatusPill }) {
  if (threadStatus.label === "Completed") {
    return (
      <HiOutlineCheckCircle
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", threadStatus.colorClass)}
      />
    );
  }
  if (threadStatus.pulse) {
    return <ThreadRunningSpinner />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", threadStatus.dotClass)}
    />
  );
}

export function ProviderAvatarWithTerminal({
  provider,
  handoffSourceProvider,
  handoffTooltip,
  terminalStatus,
  terminalCount,
}: {
  provider: ProviderKind;
  handoffSourceProvider?: ProviderKind | null;
  handoffTooltip?: string | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalCount: number;
}) {
  const showBadge = terminalCount > 1 || terminalStatus !== null;
  const badgeTooltip =
    terminalCount > 1
      ? `${terminalCount} ${pluralize(terminalCount, "terminal")} open`
      : (terminalStatus?.label ?? "Terminal open");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/55";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3 w-4.5 shrink-0 items-center"
    : "relative inline-flex size-3 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="sidebar-icon-chip absolute left-0 top-1/2 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={handoffSourceProvider!} className="size-2" />
      </span>
      <span className="sidebar-icon-chip absolute right-0 top-1/2 z-10 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={provider} className="size-2" />
      </span>
    </span>
  ) : (
    <span className={containerClass}>
      <ProviderIcon provider={provider} className="size-3" />
    </span>
  );

  const wrappedAvatar =
    hasHandoff && handoffTooltip ? (
      <Tooltip>
        <TooltipTrigger render={avatarNode} />
        <TooltipPopup side="top">{handoffTooltip}</TooltipPopup>
      </Tooltip>
    ) : (
      avatarNode
    );

  return (
    <span className="relative inline-flex shrink-0 items-center">
      {wrappedAvatar}
      {showBadge ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badgeTooltip}
                className="sidebar-icon-chip absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full px-px"
              >
                {terminalCount > 1 ? (
                  <span
                    className={cn(
                      "text-[8px] font-semibold leading-none tabular-nums",
                      badgeColorClass,
                    )}
                  >
                    {terminalCount}
                  </span>
                ) : (
                  <TerminalIcon className={cn("size-2.5", badgeColorClass)} />
                )}
              </span>
            }
          />
          <TooltipPopup side="top">{badgeTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function ThreadPrStatusBadge({
  prStatus,
  onOpen,
  className,
}: {
  prStatus: PrStatusIndicator;
  onOpen: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={prStatus.tooltip}
            className={cn(
              "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              prStatus.colorClass,
              className,
            )}
            onClick={(event) => onOpen(event, prStatus.url)}
          >
            <SidebarGlyph icon={prStatus.icon} variant="meta" className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
