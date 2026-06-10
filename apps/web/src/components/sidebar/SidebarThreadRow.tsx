// FILE: sidebar/SidebarThreadRow.tsx
// Purpose: Memoized project-thread row subscribed only to its own per-thread slices.

import { type MouseEvent, type PointerEvent as ReactPointerEvent, memo } from "react";
import { type ThreadId } from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { pluralize } from "@t3tools/shared/text";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { type SidebarThreadSummary } from "../../types";
import { resolveThreadHandoffBadgeLabel } from "../../lib/threadHandoff";
import { resolveSubagentPresentationForThread } from "../../lib/subagentPresentation";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { resolveThreadRowClassName, resolveThreadRowTrailingReserveClass } from "../Sidebar.logic";
import { TerminalIcon, ChevronDownIcon, ChevronRightIcon, DisposableThreadIcon } from "~/lib/icons";
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
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { THREAD_DRAG_MIME } from "../chat-drop-overlay/ChatPaneDropOverlay";
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

export type ThreadRowCallbacks = {
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  primeThreadActivation: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  openRenameThreadDialog: (threadId: ThreadId) => void;
  handleThreadRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
    options?: { isActive?: boolean; canToggleSubagents?: boolean },
  ) => void;
  handleThreadContextMenu: (threadId: ThreadId, position: { x: number; y: number }) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => void;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  toggleThreadPinned: (threadId: ThreadId) => void;
  toggleSubagentParent: (threadId: ThreadId) => void;
  inlineConfirmArchiveThread: (threadId: ThreadId) => void;
  dismissPendingArchiveConfirmation: (threadId: ThreadId) => void;
  setPendingArchiveConfirmationThreadId: (id: ThreadId | null) => void;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  resolveThreadStatusForSidebar: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
};

type Props = {
  thread: SidebarThreadSummary;
  orderedProjectThreadIds: readonly ThreadId[];
  depth?: number;
  childCount?: number;
  isExpanded?: boolean;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr>;
  visualActiveSidebarThreadId: ThreadId | null | undefined;
  pendingArchiveConfirmationThreadId: ThreadId | null;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  onRenamingTitleChange: (value: string) => void;
  renamingInputRef: React.MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.MutableRefObject<boolean>;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  selectedThreadIds: ReadonlySet<ThreadId>;
  temporaryThreadIds: Record<string, true | undefined>;
  draftThreadsByThreadId: Record<string, { isTemporary?: boolean }>;
  visibleThreadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  visibleThreadJumpLabelPartsByThreadId: ReadonlyMap<ThreadId, readonly string[]>;
  callbacks: ThreadRowCallbacks;
};

export const SidebarThreadRow = memo(function SidebarThreadRow({
  thread,
  orderedProjectThreadIds,
  depth = 0,
  childCount = 0,
  isExpanded = false,
  prByThreadId,
  visualActiveSidebarThreadId,
  pendingArchiveConfirmationThreadId,
  renamingThreadId,
  renamingTitle,
  onRenamingTitleChange,
  renamingInputRef,
  renamingCommittedRef,
  pinnedThreadIdSet,
  selectedThreadIds,
  temporaryThreadIds,
  draftThreadsByThreadId,
  visibleThreadJumpLabelByThreadId,
  visibleThreadJumpLabelPartsByThreadId,
  callbacks,
}: Props) {
  const threadTerminalState = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadId, thread.id),
  );

  const threadEntryPoint = threadTerminalState.entryPoint;
  const isPendingArchiveConfirmation = pendingArchiveConfirmationThreadId === thread.id;
  const isActive = visualActiveSidebarThreadId === thread.id;
  const isPinned = pinnedThreadIdSet.has(thread.id);
  const isSelected = selectedThreadIds.has(thread.id);
  const isHighlighted = isActive || isSelected;
  const threadStatus = callbacks.resolveThreadStatusForSidebar(thread);
  const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
  const terminalStatus = terminalStatusFromThreadState({
    runningTerminalIds: threadTerminalState.runningTerminalIds,
    terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
  });
  const terminalCount = threadTerminalState.terminalIds.length;
  const isDisposableThread =
    temporaryThreadIds[thread.id] === true ||
    draftThreadsByThreadId[thread.id]?.isTemporary === true;
  const secondaryMetaClass = isHighlighted
    ? "text-foreground/54 dark:text-foreground/64"
    : "text-muted-foreground/34";
  const rightMetaChips = resolveThreadRowMetaChips({
    thread,
    includeHandoffBadge: !isDisposableThread,
    handoffShownInAvatar:
      threadEntryPoint !== "terminal" &&
      !isGenericChatThreadTitle(thread.title) &&
      Boolean(thread.handoff?.sourceProvider),
  });
  const isSubagentThread = Boolean(thread.parentThreadId);
  const leadingPrStatus =
    isSubagentThread || thread.forkSourceThreadId || thread.sidechatSourceThreadId
      ? null
      : prStatus;
  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
  const subagentPresentation = isSubagentThread
    ? resolveSubagentPresentationForThread({
        thread: {
          id: thread.id,
          parentThreadId: thread.parentThreadId,
          subagentAgentId: thread.subagentAgentId,
          subagentNickname: thread.subagentNickname,
          subagentRole: thread.subagentRole,
          title: thread.title,
        },
      })
    : null;
  const canToggleSubagents = childCount > 0;
  const subagentIndentPx = Math.max(0, Math.min(depth - 1, 3) * 10);
  const showCompactMeta = !isSubagentThread;
  const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
  const threadJumpLabelParts =
    visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const childCountLabel = `${childCount} ${pluralize(childCount, "subagent")}`;
  const toggleButtonClassName = isHighlighted
    ? "border-[color:var(--color-border)] bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
    : "border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

  return (
    <SidebarMenuSubItem
      className="group/thread-row w-full opacity-85"
      data-thread-item
      onPointerLeave={() => callbacks.dismissPendingArchiveConfirmation(thread.id)}
    >
      {leadingPrStatus ? (
        <ThreadPrStatusBadge
          prStatus={leadingPrStatus}
          onOpen={callbacks.openPrLink}
          className="pointer-events-auto absolute left-1.5 top-1/2 z-30 size-5 -translate-y-1/2"
        />
      ) : null}
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        data-thread-entry-point={threadEntryPoint}
        size="sm"
        isActive={isActive}
        className={cn(
          resolveThreadRowClassName({
            isActive,
            isSelected,
          }),
          leadingPrStatus && "pl-8",
          isSubagentThread
            ? "pr-7.5"
            : resolveThreadRowTrailingReserveClass(showCompactMeta ? rightMetaChips.length : 0),
        )}
        draggable={renamingThreadId !== thread.id}
        onDragStart={(event) => {
          const dragImage = event.currentTarget as HTMLElement | null;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(THREAD_DRAG_MIME, JSON.stringify({ threadId: thread.id }));
          if (dragImage) {
            const rect = dragImage.getBoundingClientRect();
            event.dataTransfer.setDragImage(
              dragImage,
              Math.max(0, event.clientX - rect.left),
              Math.max(0, event.clientY - rect.top),
            );
          }
        }}
        onClick={(event) => {
          callbacks.handleThreadClick(event, thread.id, orderedProjectThreadIds, {
            isActive,
            canToggleSubagents,
          });
        }}
        onPointerDown={(event) => callbacks.primeThreadActivation(event, thread.id)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          callbacks.openRenameThreadDialog(thread.id);
        }}
        onPointerUp={(event) => callbacks.handleThreadRenamePointerUp(event, thread.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          callbacks.activateThreadFromSidebarIntent(thread.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
            void callbacks.handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (selectedThreadIds.size > 0) {
              callbacks.clearSelection();
            }
            void callbacks.handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        {isSubagentThread ? (
          <span
            aria-hidden="true"
            className="relative inline-flex h-3.5 w-[18px] shrink-0 items-center"
            style={{ marginLeft: `${subagentIndentPx}px` }}
          >
            <span className="absolute left-1.5 top-0 bottom-0 w-px rounded-full bg-border/35" />
            <span className="absolute left-1.5 top-1/2 h-px w-2.5 -translate-y-1/2 bg-border/35" />
            <span
              className="absolute left-1.5 top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ backgroundColor: subagentPresentation?.accentColor }}
            />
          </span>
        ) : threadEntryPoint === "terminal" ? (
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
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center text-left",
            isSubagentThread ? "gap-[5px]" : "gap-1.5",
          )}
        >
          {renamingThreadId === thread.id ? (
            <input
              ref={(el) => {
                if (el && renamingInputRef.current !== el) {
                  renamingInputRef.current = el;
                  el.focus();
                  el.select();
                }
              }}
              className="min-w-0 flex-1 truncate rounded-md border border-ring bg-transparent px-1.5 py-0.5 text-[length:var(--app-font-size-ui,12px)] outline-none"
              value={renamingTitle}
              onChange={(e) => onRenamingTitleChange(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  renamingCommittedRef.current = true;
                  void callbacks.commitRename(thread.id, renamingTitle, thread.title);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  renamingCommittedRef.current = true;
                  callbacks.cancelRename();
                }
              }}
              onBlur={() => {
                if (!renamingCommittedRef.current) {
                  void callbacks.commitRename(thread.id, renamingTitle, thread.title);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)]",
                isActive ? "text-foreground" : "text-foreground/92",
                isSubagentThread ? "leading-[18px] text-foreground/80" : "leading-5",
              )}
            >
              {isSubagentThread ? (
                <SidebarSubagentLabel
                  threadId={thread.id}
                  parentThreadId={thread.parentThreadId}
                  agentId={thread.subagentAgentId}
                  nickname={thread.subagentNickname}
                  role={thread.subagentRole}
                  title={thread.title}
                  roleClassName="text-muted-foreground/42"
                />
              ) : (
                thread.title
              )}
            </span>
          )}
          {!isSubagentThread && threadStatus?.label === "Pending Approval" ? (
            <span
              aria-label="Pending approval"
              className={cn("shrink-0 text-[10px] font-medium", threadStatus.colorClass)}
            >
              Pending
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-1">
          {canToggleSubagents ? (
            <button
              type="button"
              data-thread-selection-safe
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${childCountLabel}`}
              title={childCountLabel}
              className={cn(
                "inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border px-[5px] transition-colors",
                toggleButtonClassName,
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                callbacks.toggleSubagentParent(thread.id);
              }}
            >
              <span className="text-[9px] font-medium leading-none tabular-nums">{childCount}</span>
              {isExpanded ? (
                <SidebarGlyph icon={ChevronDownIcon} variant="chevron" />
              ) : (
                <SidebarGlyph icon={ChevronRightIcon} variant="chevron" />
              )}
            </button>
          ) : null}
          {showCompactMeta && isDisposableThread && !thread.sidechatSourceThreadId ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                    <DisposableThreadIcon />
                  </span>
                }
              />
              <TooltipPopup side="top">Disposable chat</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <div className={cn("absolute top-1/2 flex -translate-y-1/2 items-center", "right-1.5")}>
          <div className="relative flex shrink-0 items-center justify-end gap-1">
            {!isPendingArchiveConfirmation && showCompactMeta && rightMetaChips.length > 0 ? (
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
                <span
                  className={threadRowTimestampSlotClassName(
                    isSubagentThread,
                    isSubagentThread
                      ? isHighlighted
                        ? "text-foreground/38 dark:text-foreground/46"
                        : "text-muted-foreground/24"
                      : secondaryMetaClass,
                  )}
                >
                  <ThreadStatusTrailingGlyph threadStatus={threadStatus} />
                </span>
              ) : (
                <span
                  className={threadRowTimestampSlotClassName(
                    isSubagentThread,
                    isSubagentThread
                      ? isHighlighted
                        ? "text-foreground/38 dark:text-foreground/46"
                        : "text-muted-foreground/24"
                      : secondaryMetaClass,
                  )}
                >
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
                    isSubagentThread ? "h-4.5 px-1.5 text-[10px]" : undefined,
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
                    pinned={isPinned}
                    presentation="inline"
                    toneClassName={secondaryMetaClass}
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
                    className={cn("hover:text-foreground/89", secondaryMetaClass)}
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
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});
