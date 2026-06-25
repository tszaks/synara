// FILE: MemoryListRow.tsx
// Purpose: Minimal read-only list row shared by the Memory Files/Sessions/Decisions/Search panels:
//   a leading glyph, a title, a muted detail that fills the row, and optional right-aligned meta.
//   Mirrors AutomationListRow's structure/styling but stays non-interactive (read-only surface).
// Layer: Web component (Memory)

import { type ReactNode } from "react";

export function MemoryListRow({
  leading,
  title,
  detail,
  meta,
}: {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left">
      {leading}
      <span className="min-w-0 max-w-[45%] truncate text-[0.8125rem] text-foreground">{title}</span>
      {detail == null ? null : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</span>
      )}
      {meta == null ? null : (
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span>
      )}
    </div>
  );
}
