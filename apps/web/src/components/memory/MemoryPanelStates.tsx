// FILE: MemoryPanelStates.tsx
// Purpose: Shared loading / error / empty / Pallium-unavailable state rows for the Memory panels,
//   so every panel reads identically (mirrors the quiet centered states the Automations surface
//   uses). The "unavailable" state is a friendly setup prompt, never an error toast.
// Layer: Web component (Memory)

import { type ReactNode } from "react";

export function MemoryPanelLoading({ label = "Loading..." }: { readonly label?: string }) {
  return <div className="py-16 text-center text-sm text-muted-foreground">{label}</div>;
}

export function MemoryPanelError({ message }: { readonly message: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-16 text-center">
      <p className="text-sm font-medium text-foreground">Could not load memory</p>
      <p className="max-w-xs text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

export function MemoryPanelEmpty({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail ? <p className="max-w-xs text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/**
 * The Pallium-not-set-up empty state. Shown whenever a panel's result reports `available: false`,
 * so the surface degrades to a calm install prompt instead of surfacing an error.
 */
export function MemoryPalliumUnavailable() {
  return (
    <MemoryPanelEmpty
      title="Pallium not set up"
      detail="Memory is powered by Pallium. Install Pallium and set its path in Settings to index this project's history."
    />
  );
}
