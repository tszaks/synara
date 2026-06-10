// FILE: _chat.plugins.lazy.tsx
// Purpose: Lazy-loaded plugins route component — only fetched when the user navigates to /plugins.
// Layer: Route screen (lazy chunk)
// Exports: Lazy route component for `/plugins`

import { createLazyFileRoute } from "@tanstack/react-router";
import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createLazyFileRoute("/_chat/plugins")({
  component: PluginLibrary,
});
