// FILE: ChatView.modelOptions.ts
// Purpose: Provider model discovery + composer model selection state for ChatView.
//          Owns the per-provider dynamic model/agent queries, merges discovered models
//          with static/custom options, and derives the composer's selected model,
//          picker, and dispatch state. Extracted verbatim from ChatView.tsx.
// Layer: Web chat state hook
// Exports: useProviderModelOptions
// Depends on: provider discovery react-query options, appSettings model options,
//             composer draft store, ChatView.helpers/ChatView.logic derivations.

import { type ModelSelection, type ProviderKind, type ThreadId } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  providerAgentsQueryOptions,
  providerModelsQueryOptions,
} from "~/lib/providerDiscoveryReactQuery";
import {
  type AppSettings,
  getAppModelOptions,
  getCustomModelsByProvider,
  getProviderStartOptions,
} from "../appSettings";
import { useEffectiveComposerModelState } from "../composerDraftStore";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import { buildModelSelection, type ProviderModelOption } from "../providerModelOptions";
import { compareProvidersByOrder } from "../providerOrdering";
import { mergeDynamicModelOptions } from "./ChatView.helpers";
import { shouldShowComposerModelBootstrapSkeleton } from "./ChatView.logic";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import { AVAILABLE_PROVIDER_OPTIONS } from "./chat/ProviderModelPicker";
import { resolveRuntimeModelDescriptor } from "./chat/runtimeModelCapabilities";

export function useProviderModelOptions(input: {
  threadId: ThreadId;
  settings: AppSettings;
  selectedProvider: ProviderKind;
  lockedProvider: ProviderKind | null;
  sessionProvider: ProviderKind | null;
  isModelPickerOpen: boolean;
  showExpandedCursorModelVariants: boolean;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  draftModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  prompt: string;
}) {
  const {
    threadId,
    settings,
    selectedProvider,
    lockedProvider,
    sessionProvider,
    isModelPickerOpen,
    showExpandedCursorModelVariants,
    threadModelSelection,
    projectModelSelection,
    draftModelSelectionByProvider,
    prompt,
  } = input;

  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const composerModelHintByProvider = useMemo<Record<ProviderKind, string | null>>(() => {
    const resolveHint = (provider: ProviderKind): string | null =>
      draftModelSelectionByProvider[provider]?.model ??
      (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
      (projectModelSelection?.provider === provider ? projectModelSelection.model : null);

    return {
      codex: resolveHint("codex"),
      claudeAgent: resolveHint("claudeAgent"),
      cursor: resolveHint("cursor"),
      gemini: resolveHint("gemini"),
      grok: resolveHint("grok"),
      kilo: resolveHint("kilo"),
      opencode: resolveHint("opencode"),
      pi: resolveHint("pi"),
    };
  }, [draftModelSelectionByProvider, projectModelSelection, threadModelSelection]);
  const claudeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicModelsQuery = useQuery(providerModelsQueryOptions({ provider: "codex" }));
  const openCodeModelDiscoveryEnabled =
    selectedProvider === "opencode" || lockedProvider === "opencode" || isModelPickerOpen;
  const kiloModelDiscoveryEnabled =
    selectedProvider === "kilo" || lockedProvider === "kilo" || isModelPickerOpen;
  const cursorDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "cursor",
      binaryPath: settings.cursorBinaryPath || null,
      apiEndpoint: settings.cursorApiEndpoint || null,
      enabled: selectedProvider === "cursor" || lockedProvider === "cursor" || isModelPickerOpen,
    }),
  );
  const geminiModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "gemini",
      binaryPath: settings.geminiBinaryPath || null,
      enabled: selectedProvider === "gemini" || lockedProvider === "gemini",
    }),
  );
  const grokDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "grok",
      binaryPath: settings.grokBinaryPath || null,
      enabled: selectedProvider === "grok" || lockedProvider === "grok" || isModelPickerOpen,
    }),
  );
  const openCodeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      enabled: openCodeModelDiscoveryEnabled,
    }),
  );
  const kiloDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "kilo",
      binaryPath: settings.kiloBinaryPath || null,
      enabled: kiloModelDiscoveryEnabled,
    }),
  );
  const piDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "pi",
      binaryPath: settings.piBinaryPath || null,
      agentDir: settings.piAgentDir || null,
      enabled: selectedProvider === "pi" || lockedProvider === "pi" || isModelPickerOpen,
    }),
  );
  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicAgentsQuery = useQuery(providerAgentsQueryOptions({ provider: "codex" }));
  const openCodeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "opencode", enabled: openCodeModelDiscoveryEnabled }),
  );
  const kiloDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "kilo", enabled: kiloModelDiscoveryEnabled }),
  );
  const cursorRuntimeModels = useMemo(
    () =>
      showExpandedCursorModelVariants
        ? (cursorDynamicModelsQuery.data?.models ?? [])
        : collapseCursorModelVariants(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models, showExpandedCursorModelVariants],
  );
  const cursorModelDiscoveryEnabled =
    selectedProvider === "cursor" || lockedProvider === "cursor" || isModelPickerOpen;
  const hasResolvedCursorModelDiscovery =
    cursorDynamicModelsQuery.data?.source === "cursor.cli" &&
    (cursorDynamicModelsQuery.data.models.length ?? 0) > 0;
  const cursorModelDiscoveryPending =
    cursorModelDiscoveryEnabled &&
    !hasResolvedCursorModelDiscovery &&
    (cursorDynamicModelsQuery.isLoading || cursorDynamicModelsQuery.isFetching);
  const hasResolvedKiloModelDiscovery =
    (kiloDynamicModelsQuery.data?.source === "kilo-cli" ||
      kiloDynamicModelsQuery.data?.source === "kilo") &&
    (kiloDynamicModelsQuery.data.models.length ?? 0) > 0;
  const kiloModelDiscoveryPending =
    kiloModelDiscoveryEnabled &&
    !hasResolvedKiloModelDiscovery &&
    (kiloDynamicModelsQuery.isLoading || kiloDynamicModelsQuery.isFetching);
  const modelOptionsByProvider = useMemo(() => {
    const staticOptions: Record<ProviderKind, ReturnType<typeof getAppModelOptions>> = {
      codex: getAppModelOptions(
        "codex",
        customModelsByProvider.codex,
        composerModelHintByProvider.codex,
      ),
      claudeAgent: getAppModelOptions(
        "claudeAgent",
        customModelsByProvider.claudeAgent,
        composerModelHintByProvider.claudeAgent,
      ),
      cursor: getAppModelOptions(
        "cursor",
        customModelsByProvider.cursor,
        composerModelHintByProvider.cursor,
      ),
      gemini: getAppModelOptions(
        "gemini",
        customModelsByProvider.gemini,
        composerModelHintByProvider.gemini,
      ),
      grok: getAppModelOptions(
        "grok",
        customModelsByProvider.grok,
        composerModelHintByProvider.grok,
      ),
      kilo: getAppModelOptions(
        "kilo",
        customModelsByProvider.kilo,
        composerModelHintByProvider.kilo,
      ),
      opencode: getAppModelOptions(
        "opencode",
        customModelsByProvider.opencode,
        composerModelHintByProvider.opencode,
      ),
      pi: getAppModelOptions("pi", customModelsByProvider.pi, composerModelHintByProvider.pi),
    };
    const result: Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    > = { ...staticOptions };

    const dynamicSources: Record<ProviderKind, typeof claudeDynamicModelsQuery.data> = {
      claudeAgent: claudeDynamicModelsQuery.data,
      codex: codexDynamicModelsQuery.data,
      cursor:
        cursorDynamicModelsQuery.data === undefined
          ? undefined
          : { ...cursorDynamicModelsQuery.data, models: cursorRuntimeModels },
      gemini: geminiModelsQuery.data,
      grok: grokDynamicModelsQuery.data,
      kilo: kiloDynamicModelsQuery.data,
      opencode: openCodeDynamicModelsQuery.data,
      pi: piDynamicModelsQuery.data,
    };

    for (const provider of [
      "claudeAgent",
      "codex",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ] as const) {
      const dynamicModels = dynamicSources[provider]?.models;
      if (dynamicModels && dynamicModels.length > 0) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels: dynamicModels.map((model) => ({
            slug: model.slug,
            ...(model.name !== undefined ? { name: model.name } : {}),
            ...(model.upstreamProviderId !== undefined
              ? { upstreamProviderId: model.upstreamProviderId }
              : {}),
            ...(model.upstreamProviderName !== undefined
              ? { upstreamProviderName: model.upstreamProviderName }
              : {}),
          })),
        });
      }
    }

    return result;
  }, [
    claudeDynamicModelsQuery.data,
    composerModelHintByProvider,
    codexDynamicModelsQuery.data,
    cursorDynamicModelsQuery.data,
    cursorRuntimeModels,
    customModelsByProvider,
    geminiModelsQuery.data,
    grokDynamicModelsQuery.data,
    kiloDynamicModelsQuery.data,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
  ]);
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    threadModelSelection,
    projectModelSelection,
    customModelsByProvider,
    availableModelOptionsByProvider: modelOptionsByProvider,
  });
  const runtimeModelsByProvider = useMemo(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.models ?? [],
      codex: codexDynamicModelsQuery.data?.models ?? [],
      cursor: cursorRuntimeModels,
      gemini: geminiModelsQuery.data?.models ?? [],
      grok: grokDynamicModelsQuery.data?.models ?? [],
      kilo: kiloDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
    }),
    [
      claudeDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      geminiModelsQuery.data?.models,
      grokDynamicModelsQuery.data?.models,
      kiloDynamicModelsQuery.data?.models,
      openCodeDynamicModelsQuery.data?.models,
      piDynamicModelsQuery.data?.models,
    ],
  );
  const providerModelsQueryByProvider = {
    claudeAgent: claudeDynamicModelsQuery,
    codex: codexDynamicModelsQuery,
    cursor: cursorDynamicModelsQuery,
    gemini: geminiModelsQuery,
    grok: grokDynamicModelsQuery,
    kilo: kiloDynamicModelsQuery,
    opencode: openCodeDynamicModelsQuery,
    pi: piDynamicModelsQuery,
  } as const;
  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [runtimeModelsByProvider, selectedModel, selectedProvider],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModel: selectedRuntimeModel,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedRuntimeModel],
  );
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const draftModelSelectionForSelectedProvider =
    draftModelSelectionByProvider[selectedProvider] ?? null;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    if (selectedProvider === "pi" && draftModelSelectionForSelectedProvider?.provider === "pi") {
      return buildModelSelection(
        selectedProvider,
        draftModelSelectionForSelectedProvider.model,
        selectedModelOptionsForDispatch ?? draftModelSelectionForSelectedProvider.options,
      );
    }
    return buildModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch);
  }, [
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
  ]);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const selectedModelForPicker =
    selectedModelSelection.provider === selectedProvider
      ? selectedModelSelection.model
      : selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const persistedComposerModelSelection =
    sessionProvider && threadModelSelection?.provider !== sessionProvider
      ? projectModelSelection?.provider === selectedProvider
        ? projectModelSelection
        : null
      : (threadModelSelection ?? projectModelSelection ?? null);
  const selectedProviderModelsQuery = providerModelsQueryByProvider[selectedProvider];
  const providerModelsLoading =
    selectedProvider === "cursor"
      ? cursorModelDiscoveryPending
      : selectedProvider === "kilo"
        ? kiloModelDiscoveryPending
        : selectedProviderModelsQuery !== undefined &&
          (selectedProviderModelsQuery.isLoading ||
            (selectedProviderModelsQuery.isFetching &&
              selectedProviderModelsQuery.data === undefined));
  const selectedProviderRequiresRuntimeModels =
    selectedProvider === "cursor" || selectedProvider === "kilo";
  const selectedProviderRuntimeModelDiscoveryPending =
    selectedProvider === "cursor"
      ? cursorModelDiscoveryPending
      : selectedProvider === "kilo"
        ? kiloModelDiscoveryPending
        : false;
  const showComposerModelBootstrapSkeleton = shouldShowComposerModelBootstrapSkeleton({
    selectedProvider,
    selectedModel,
    persistedModelSelection: persistedComposerModelSelection,
    draftModelSelection: draftModelSelectionForSelectedProvider,
    providerModelsLoading,
    requiresDiscoveredModels: selectedProviderRequiresRuntimeModels,
  });
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const searchableModelOptions = useMemo(
    () =>
      [...AVAILABLE_PROVIDER_OPTIONS]
        .sort((left, right) =>
          compareProvidersByOrder(settings.providerOrder, left.value, right.value),
        )
        .filter((option) => {
          if (lockedProvider !== null) {
            return option.value === lockedProvider;
          }
          // Always keep the currently selected provider visible in search even if
          // it's hidden in the picker, so the user can still see and switch from
          // its models without first unhiding the provider in settings.
          if (option.value === selectedProvider) {
            return true;
          }
          return !hiddenProviderSet.has(option.value);
        })
        .flatMap((option) =>
          modelOptionsByProvider[option.value].map(
            ({ slug, name, upstreamProviderId, upstreamProviderName }) => ({
              provider: option.value,
              providerLabel: option.label,
              slug,
              name,
              searchSlug: slug.toLowerCase(),
              searchName: name.toLowerCase(),
              searchProvider: option.label.toLowerCase(),
              searchUpstreamProvider: (
                upstreamProviderName ??
                upstreamProviderId ??
                ""
              ).toLowerCase(),
            }),
          ),
        ),
    [
      hiddenProviderSet,
      lockedProvider,
      modelOptionsByProvider,
      selectedProvider,
      settings.providerOrder,
    ],
  );

  return {
    customModelsByProvider,
    claudeDynamicAgentsQuery,
    codexDynamicAgentsQuery,
    openCodeDynamicAgentsQuery,
    kiloDynamicAgentsQuery,
    cursorModelDiscoveryPending,
    kiloModelDiscoveryPending,
    modelOptionsByProvider,
    composerModelOptions,
    selectedModel,
    runtimeModelsByProvider,
    selectedRuntimeModel,
    composerProviderState,
    selectedModelSelection,
    providerOptionsForDispatch,
    selectedModelForPickerWithCustomFallback,
    selectedProviderRuntimeModelDiscoveryPending,
    showComposerModelBootstrapSkeleton,
    searchableModelOptions,
  };
}
