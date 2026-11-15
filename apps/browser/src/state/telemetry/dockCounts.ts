import type { WindowEvent } from "../../platform/windows";

type ScreenEdge = NonNullable<Extract<WindowEvent, { type: "sidebarEdge" }>["screenEdge"]>;

const NONE = {
  sidebar_slides: 0,
  sidebar_slides_past_target: 0,
  sidebar_peek_reveals_held_back: 0,
  sidebar_peek_resizes: 0,
  sidebar_peek_closes_while_resizing: 0,
  sidebar_screen_edge_stops: 0,
  sidebar_screen_edge_pass_throughs: 0,
};
let counts = { ...NONE };

export function noteSidebarSlide(pastTarget: boolean) {
  counts.sidebar_slides++;
  if (pastTarget) counts.sidebar_slides_past_target++;
}

export const noteSidebarPeekRevealHeldBack = () => void counts.sidebar_peek_reveals_held_back++;

export const noteSidebarPeekResize = () => void counts.sidebar_peek_resizes++;

export const noteSidebarPeekClosedWhileResizing = () => void counts.sidebar_peek_closes_while_resizing++;

export const noteSidebarScreenEdge = (edge: ScreenEdge) => void counts[edge === "stopped" ? "sidebar_screen_edge_stops" : "sidebar_screen_edge_pass_throughs"]++;

export function takeDockCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
