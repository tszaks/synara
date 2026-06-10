// FILE: sidebar/SidebarPinnedThreadRow.tsx
// Purpose: Memoized pinned-thread row subscribed only to its own per-thread slices.

import { type MouseEvent, type PointerEvent as ReactPointerEvent, memo } from "react";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { useStore } from "../../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { type SidebarThreadSummary } from "../../types";
import { resolveThreadHandoffBadgeLabel } from "../../lib/threadHandoff";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { TerminalIcon } from "~/lib/icons";
import { HiOutlineArchiveBox } from "react-icons/hi2";
import { cn } from "~/lib/utils";
import { SidebarGlyph } from "../sidebarGlyphs";
import { SidebarMetaChipStack } from "../SidebarMetaChip";
import { SidebarRowHoverActions } from "../SidebarRowHoverActions";
import { SidebarIconButton } from "../SidebarIconButton";
import { ThreadPinToggleButton } from "../ThreadPinToggleButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Kbd, KbdGroup } from "../ui/kbd";
import { formatRelativeTime } from "../Sidebar.logic";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../../sidebarRowStyles";
import { SidebarSubagentLabel } from "./SidebarSubagentLabel";
import {
  THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME,
  EMPTY_SHORTCUT_PARTS,
  terminalStatusFromThreadState,
  prStatusIndicator,
  resolveThreadRowMetaChips,
  threadRowTimestampSlotClassName,
  ThreadStatusTrailingGlyph,
  ProviderAvatarWithTerminal,
  ThreadPrStatusBadge,
  type ThreadPr,
} from "./threadRowShared";

export type PinnedThreadRowCallbacks = {
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  primeThreadActivation: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  openRenameThreadDialog: (threadId: ThreadId) => void;
  handleThreadRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  handleThreadContextMenu: (threadId: ThreadId, position: { x: number; y: number }) => void;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  toggleThreadPinned: (threadId: ThreadId) => void;
  inlineConfirmArchiveThread: (threadId: ThreadId) => void;
  dismissPendingArchiveConfirmation: (threadId: ThreadId) => void;
  setPendingArchiveConfirmationThreadId: (id: ThreadId | null) => void;
  resolvePinnedThreadProjectLabel: (projectId: ProjectId) => string | null;
  resolveThreadStatusForSidebar: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
};

type Props = {
  threadId: ThreadId;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr>;
  visualActiveSidebarThreadId: ThreadId | null | undefined;
  pendingArchiveConfirmationThreadId: ThreadId | null;
  visibleThreadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  visibleThreadJumpLabelPartsByThreadId: ReadonlyMap<ThreadId, readonly string[]>;
  callbacks: PinnedThreadRowCallbacks;
};

export const SidebarPinnedThreadRow = memo(function SidebarPinnedThreadRow({
  threadId,
  prByThreadId,
  visualActiveSidebarThreadId,
  pendingArchiveConfirmationThreadId,
  visibleThreadJumpLabelByThreadId,
  visibleThreadJumpLabelPartsByThreadId,
  callbacks,
}: Props) {
  const thread = useStore((s) => s.sidebarThreadSummaryById[threadId]);
  const threadTerminalState = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadId, threadId),
  );

  if (!thread) return null;

  const threadEntryPoint = threadTerminalState.entryPoint;
  const terminalStatus = terminalStatusFromThreadState({
    runningTerminalIds: threadTerminalState.runningTerminalIds,
    terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
  });
  const terminalCount = threadTerminalState.terminalIds.length;
  const isPendingArchiveConfirmation = pendingArchiveConfirmationThreadId === thread.id;
  const isActive = visualActiveSidebarThreadId === thread.id;
  const projectLabel = callbacks.resolvePinnedThreadProjectLabel(thread.projectId);
  const rightMetaChips = resolveThreadRowMetaChips({
    thread,
    includeHandoffBadge: true,
    handoffShownInAvatar:
      threadEntryPoint !== "terminal" &&
      !isGenericChatThreadTitle(thread.title) &&
      Boolean(thread.handoff?.sourceProvider),
  });
  const threadStatus = callbacks.resolveThreadStatusForSidebar(thread);
  const isSubagentThread = Boolean(thread.parentThreadId);
  const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
  const leadingPrStatus =
    isSubagentThread || thread.forkSourceThreadId || thread.sidechatSourceThreadId
      ? null
      : prStatus;
  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
  const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
  const threadJumpLabelParts =
    visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const showThreadIdentityGlyph = threadEntryPoint === "terminal" || showThreadProviderAvatar;
  // Pinned rows keep a constant timestamp tone regardless of active state
  // (the active-aware tone only applies to regular thread rows).
  const toneClassName = "text-muted-foreground/38";
  const toneHoverClass = "text-muted-foreground/42";

  return (
    <div
      className="group/thread-row relative w-full opacity-85"
      onPointerLeave={() => callbacks.dismissPendingArchiveConfirmation(thread.id)}
    >
      {leadingPrStatus ? (
        <ThreadPrStatusBadge
          prStatus={leadingPrStatus}
          onOpen={callbacks.openPrLink}
          className="pointer-events-auto absolute left-1.5 top-1/2 z-30 size-5 -translate-y-1/2"
        />
      ) : null}
      <div
        role="button"
        tabIndex={0}
        data-thread-item
        className={cn(
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          "grid w-full items-center gap-x-1.5 transition-colors",
          leadingPrStatus && "pl-8",
          showThreadIdentityGlyph
            ? "grid-cols-[auto_minmax(0,1fr)_auto_3.5rem]"
            : "grid-cols-[minmax(0,1fr)_auto_3.5rem]",
          isActive
            ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
            : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
        )}
        onPointerDown={(event) => callbacks.primeThreadActivation(event, thread.id)}
        onClick={() => callbacks.activateThreadFromSidebarIntent(thread.id)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          callbacks.openRenameThreadDialog(thread.id);
        }}
        onPointerUp={(event) => callbacks.handleThreadRenamePointerUp(event, thread.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            callbacks.activateThreadFromSidebarIntent(thread.id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void callbacks.handleThreadContextMenu(thread.id, {
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        {threadEntryPoint === "terminal" ? (
          <SidebarGlyph
            icon={TerminalIcon}
            variant="chrome"
            className="text-[var(--color-text-accent)]"
          />
        ) : showThreadProviderAvatar ? (
          <ProviderAvatarWithTerminal
            provider={thread.session?.provider ?? thread.modelSelection.provider}
            handoffSourceProvider={thread.handoff?.sourceProvider ?? null}
            handoffTooltip={handoffBadgeLabel}
            terminalStatus={terminalStatus}
            terminalCount={terminalCount}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 flex-1 truncate" data-testid={`thread-title-${thread.id}`}>
                  {isSubagentThread ? (
                    <SidebarSubagentLabel
                      threadId={thread.id}
                      parentThreadId={thread.parentThreadId}
                      agentId={thread.subagentAgentId}
                      nickname={thread.subagentNickname}
                      role={thread.subagentRole}
                      title={thread.title}
                    />
                  ) : (
                    thread.title
                  )}
                </span>
              }
            />
            <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
              {thread.title}
            </TooltipPopup>
          </Tooltip>
          {!isSubagentThread && threadStatus?.label === "Pending Approval" ? (
            <span
              aria-label="Pending approval"
              className={cn("shrink-0 text-[10px] font-medium", threadStatus.colorClass)}
            >
              Pending
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 max-w-[3rem] shrink items-center justify-end">
          {projectLabel ? (
            <span className="truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/38">
              {projectLabel}
            </span>
          ) : null}
        </div>
        <div className="flex w-14 shrink-0 items-center justify-end">
          <div className="relative flex shrink-0 items-center justify-end gap-1">
            {!isPendingArchiveConfirmation && rightMetaChips.length > 0 ? (
              <div className={THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME}>
                <SidebarMetaChipStack chips={rightMetaChips} />
              </div>
            ) : null}
            {!isPendingArchiveConfirmation && threadJumpLabel ? (
              <KbdGroup className={THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME}>
                {threadJumpLabelParts.map((part) => (
                  <Kbd key={part}>{part}</Kbd>
                ))}
              </KbdGroup>
            ) : null}
            {!isPendingArchiveConfirmation && !threadJumpLabel ? (
              threadStatus ? (
                <span className={threadRowTimestampSlotClassName(isSubagentThread, toneClassName)}>
                  <ThreadStatusTrailingGlyph threadStatus={threadStatus} />
                </span>
              ) : (
                <span className={threadRowTimestampSlotClassName(isSubagentThread, toneClassName)}>
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              )
            ) : null}
            <SidebarRowHoverActions
              threadId={thread.id}
              pinnedVisible={isPendingArchiveConfirmation}
            >
              {isPendingArchiveConfirmation ? (
                <button
                  type="button"
                  aria-label="Confirm archive"
                  title="Confirm archive"
                  className={cn(
                    "pointer-events-auto inline-flex h-5 items-center rounded-full px-2.5 text-[10px] font-normal leading-none tracking-[-0.01em] opacity-100 transition-colors",
                    "bg-red-400/12 text-red-400 hover:bg-red-400/16 hover:text-red-300",
                    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-red-400/45",
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void callbacks.inlineConfirmArchiveThread(thread.id);
                  }}
                >
                  <span>Confirm</span>
                </button>
              ) : (
                <div className="pointer-events-auto inline-flex items-center gap-1">
                  <ThreadPinToggleButton
                    pinned={true}
                    presentation="inline"
                    toneClassName={toneHoverClass}
                    onToggle={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      callbacks.toggleThreadPinned(thread.id);
                    }}
                  />
                  <SidebarIconButton
                    icon={HiOutlineArchiveBox}
                    label="Archive thread"
                    title="Archive thread"
                    data-testid={`thread-archive-${thread.id}`}
                    size={isSubagentThread ? "sm" : "md"}
                    glyph={isSubagentThread ? "compact" : "meta"}
                    className={cn("hover:text-foreground/89", toneHoverClass)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      callbacks.setPendingArchiveConfirmationThreadId(thread.id);
                    }}
                  />
                </div>
              )}
            </SidebarRowHoverActions>
          </div>
        </div>
      </div>
    </div>
  );
});
