// FILE: ChatView.helpers.tsx
// Purpose: Module-level constants, pure helpers, and tiny presentational pieces shared
//          by the ChatView component body. Extracted verbatim from ChatView.tsx so the
//          main file stays focused on orchestration/state wiring.
// Layer: Web chat presentation helpers
// Exports: stable EMPTY_* sentinels, composer/banner key builders, prompt formatting
//          helpers, dynamic model option merging, and composer loading placeholders.
// Depends on: contracts types, shared model capabilities, ChatView.logic blob helpers.

import {
  type ClaudeCodeEffort,
  type EditorId,
  type MessageId,
  type OrchestrationThreadActivity,
  type PinnedMessage,
  type ProjectEntry,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderKind,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderStartOptions,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
  type ThreadMarker,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  normalizeModelSlug,
} from "@t3tools/shared/model";

import { RefreshCwIcon } from "~/lib/icons";
import { normalizeCustomBinaryPath } from "~/lib/providerAvailability";
import { cn } from "~/lib/utils";
import { type ComposerImageAttachment } from "../composerDraftStore";
import { formatAssistantSelectionQueuePreview } from "../lib/assistantSelections";
import { type ComposerSuggestion } from "../lib/composerSuggestions";
import { formatTerminalContextLabel, type TerminalContextDraft } from "../lib/terminalContext";
import { type PendingUserInputDraftAnswer } from "../pendingUserInput";
import { formatProviderModelOptionName, type ProviderModelOption } from "../providerModelOptions";
import { type createAllThreadsSelector } from "../storeSelectors";
import { type ChatMessage, type Thread } from "../types";
import { revokeBlobPreviewUrl } from "./ChatView.logic";
import { type RateLimitStatus } from "./chat/RateLimitBanner";
import { Skeleton } from "./ui/skeleton";

export const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
export const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
export const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
export const EMPTY_MESSAGES: ChatMessage[] = [];
export const EMPTY_PINNED_MESSAGES: readonly PinnedMessage[] = [];
export const EMPTY_THREAD_MARKERS: readonly ThreadMarker[] = [];
export const EMPTY_PINNED_TEXT: ReadonlyMap<MessageId, string> = new Map();
export const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
export const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
export const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
export const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
export const EMPTY_COMPOSER_SUGGESTIONS: ComposerSuggestion[] = [];
const EMPTY_SUGGESTION_SOURCE_THREADS: Thread[] = [];
export const selectEmptyComposerSuggestionThreads: ReturnType<
  typeof createAllThreadsSelector
> = () => EMPTY_SUGGESTION_SOURCE_THREADS;

export function revokeBlobPreviewUrlsAfterPaint(previewUrls: readonly string[]): void {
  if (previewUrls.length === 0 || typeof window === "undefined") {
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }, 0);
  });
}

export function eventTargetsComposer(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  const target = event.target;
  return target instanceof Node ? composerForm.contains(target) : false;
}

export function canHandleComposerPickerShortcut(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  if (eventTargetsComposer(event, composerForm)) return true;
  const target = event.target;
  return (
    target === document.body ||
    target === document.documentElement ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}
export const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
export const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
export const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
export const MAX_DISMISSED_PROVIDER_HEALTH_BANNERS = 50;

export function getThreadProviderCustomBinaryPathKey(
  threadId: Thread["id"],
  provider: ProviderKind,
) {
  return `${threadId}:${provider}`;
}

export function getConfirmedCustomBinarySessionKey(
  thread: Thread | null | undefined,
  provider: ProviderKind,
): string | null {
  const session = thread?.session;
  if (!thread || session?.provider !== provider) {
    return null;
  }
  if (session.status !== "ready" && session.status !== "running") {
    return null;
  }
  return getThreadProviderCustomBinaryPathKey(thread.id, provider);
}

export function getProviderStartOptionsCustomBinaryPath(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): string | null {
  switch (provider) {
    case "codex":
      return normalizeCustomBinaryPath(providerOptions?.codex?.binaryPath);
    case "claudeAgent":
      return normalizeCustomBinaryPath(providerOptions?.claudeAgent?.binaryPath);
    case "gemini":
      return normalizeCustomBinaryPath(providerOptions?.gemini?.binaryPath);
    case "grok":
      return normalizeCustomBinaryPath(providerOptions?.grok?.binaryPath);
    case "kilo":
      return normalizeCustomBinaryPath(providerOptions?.kilo?.binaryPath);
    case "opencode":
      return normalizeCustomBinaryPath(providerOptions?.opencode?.binaryPath);
    case "cursor":
      return normalizeCustomBinaryPath(providerOptions?.cursor?.binaryPath);
    case "pi":
      return normalizeCustomBinaryPath(providerOptions?.pi?.binaryPath);
  }
}

export function getProviderHealthBannerDismissalKey(
  status: ServerProviderStatus | null,
): string | null {
  if (!status || status.status === "ready") {
    return null;
  }
  return [
    status.provider,
    status.status,
    status.available ? "available" : "unavailable",
    status.authStatus,
    status.message?.trim() ?? "",
  ].join("\u001f");
}

export function getRateLimitBannerDismissalKey(
  status: RateLimitStatus | null,
  threadId: Thread["id"] | null,
): string | null {
  if (!status || !threadId) {
    return null;
  }
  return [
    threadId,
    status.status,
    status.resetsAt ?? "",
    typeof status.utilization === "number" ? String(Math.round(status.utilization * 100)) : "",
  ].join("\u001f");
}

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

export const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];

export function formatOutgoingPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  effort: string | null;
  text: string;
}): string {
  const caps = getModelCapabilities(params.provider, params.model);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}

export function buildQueuedComposerPreviewText(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  assistantSelections: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): string {
  if (input.trimmedPrompt.length > 0) {
    return input.trimmedPrompt;
  }
  const firstImage = input.images[0];
  if (firstImage) {
    return `Image: ${firstImage.name}`;
  }
  if (input.assistantSelections.length > 0) {
    return formatAssistantSelectionQueuePreview(input.assistantSelections.length);
  }
  const firstTerminalContext = input.terminalContexts[0];
  if (firstTerminalContext) {
    return formatTerminalContextLabel(firstTerminalContext);
  }
  return "Queued follow-up";
}

export const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
export const VOICE_RECORDER_ACTION_ARM_DELAY_MS = 250;

export function warnVoiceGuard(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }
  if (details) {
    console.warn(`[voice] ${event}`, details);
    return;
  }
  console.warn(`[voice] ${event}`);
}

function normalizeDynamicModelSlug(provider: ProviderKind, slug: string): string {
  if (provider === "claudeAgent") {
    const withoutContextSuffix = slug.replace(/\[[^\]]+\]$/u, "");
    return normalizeModelSlug(withoutContextSuffix, provider) ?? withoutContextSuffix;
  }
  if (provider === "grok") {
    return slug.trim();
  }
  return normalizeModelSlug(slug, provider) ?? slug;
}

export function mergeDynamicModelOptions(input: {
  provider: ProviderKind;
  staticOptions: ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>;
  dynamicModels: ReadonlyArray<{
    slug: string;
    name?: string | null;
    upstreamProviderId?: string | null;
    upstreamProviderName?: string | null;
  }>;
}): ReadonlyArray<ProviderModelOption & { isCustom?: boolean }> {
  const staticNameBySlug = new Map(input.staticOptions.map((model) => [model.slug, model.name]));
  const dynamicNormalizedSlugs = new Set<string>();
  const normalizedDynamicOptions: ProviderModelOption[] = [];

  for (const dynamicModel of input.dynamicModels) {
    const rawName = dynamicModel.name?.trim() ?? "";
    const isClaudeDefaultAlias =
      input.provider === "claudeAgent" &&
      (rawName.toLowerCase() === "default (recommended)" ||
        rawName.toLowerCase() === "default recommended" ||
        dynamicModel.slug.trim().toLowerCase() === "default");
    if (isClaudeDefaultAlias) {
      continue;
    }

    const normalizedSlug = normalizeDynamicModelSlug(input.provider, dynamicModel.slug);
    const rawSlug = dynamicModel.slug.trim().toLowerCase();
    const displayNameFallback = formatProviderModelOptionName({
      provider: input.provider,
      slug: normalizedSlug,
    });
    if (dynamicNormalizedSlugs.has(normalizedSlug)) {
      continue;
    }
    dynamicNormalizedSlugs.add(normalizedSlug);
    normalizedDynamicOptions.push({
      slug: normalizedSlug,
      name:
        staticNameBySlug.get(normalizedSlug) ??
        (rawName.length > 0 &&
        rawName.toLowerCase() !== rawSlug &&
        rawName.toLowerCase() !== normalizedSlug.toLowerCase()
          ? rawName
          : displayNameFallback),
      ...(dynamicModel.upstreamProviderId?.trim()
        ? { upstreamProviderId: dynamicModel.upstreamProviderId.trim() }
        : {}),
      ...(dynamicModel.upstreamProviderName?.trim()
        ? { upstreamProviderName: dynamicModel.upstreamProviderName.trim() }
        : {}),
    });
  }

  const customOnlyModels = input.staticOptions.filter(
    (model) => "isCustom" in model && model.isCustom && !dynamicNormalizedSlugs.has(model.slug),
  );
  const staticBuiltInModels = input.staticOptions.filter(
    (model) => !("isCustom" in model) || model.isCustom !== true,
  );
  const missingStaticBuiltIns =
    (input.provider === "kilo" || input.provider === "opencode" || input.provider === "cursor") &&
    normalizedDynamicOptions.length > 0
      ? []
      : staticBuiltInModels.filter((model) => !dynamicNormalizedSlugs.has(model.slug));

  const orderedDynamicOptions =
    input.provider === "claudeAgent"
      ? normalizedDynamicOptions.toReversed()
      : normalizedDynamicOptions;

  return [...orderedDynamicOptions, ...missingStaticBuiltIns, ...customOnlyModels];
}

export function skillMentionPrefix(provider: string): string {
  if (provider === "pi") return "/skill:";
  return "/";
}

export const providerMentionReferencesEqual = (
  left: ReadonlyArray<ProviderMentionReference>,
  right: ReadonlyArray<ProviderMentionReference>,
): boolean =>
  left.length === right.length &&
  left.every(
    (mention, index) => mention.path === right[index]?.path && mention.name === right[index]?.name,
  );

export const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

export const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

export function ComposerControlSkeleton(props: { widthClassName: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md border border-border/50 px-2",
        props.widthClassName,
      )}
    >
      <Skeleton className="h-3.5 w-full rounded-full" />
    </div>
  );
}

export function ComposerModelLoadingControl(props: { widthClassName: string }) {
  return (
    <div
      aria-label="Loading models"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md border border-border/50 px-2 text-muted-foreground",
        props.widthClassName,
      )}
    >
      <RefreshCwIcon aria-hidden="true" className="size-3.5 animate-spin" />
      <span className="truncate text-[length:var(--app-font-size-ui-xs,11px)]">Loading models</span>
    </div>
  );
}
