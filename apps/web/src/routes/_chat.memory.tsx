import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/memory")({
  component: MemoryLayout,
});

// Layout-only route so /memory (index) and any future /memory/$entryId (detail) each render as
// their own full page rather than nesting one inside the other (mirrors the Automations layout).
function MemoryLayout() {
  return <Outlet />;
}
