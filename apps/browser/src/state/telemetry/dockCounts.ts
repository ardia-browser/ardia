import type { WindowEvent } from "../../platform/windows";

type ScreenEdge = NonNullable<Extract<WindowEvent, { type: "sidebarEdge" }>["screenEdge"]>;

const NONE = {
  sidebar_slides: 0,
  sidebar_slides_past_target: 0,
  sidebar_page_full_screen_peeks: 0,
  sidebar_peek_reveals_held_back: 0,
  sidebar_peek_resizes: 0,
  sidebar_peek_closes_while_resizing: 0,
  sidebar_screen_edge_crossings: 0,
  sidebar_screen_edge_returns: 0,
  sidebar_full_screen_peeks: 0,
  sidebar_full_screen_peek_quick_closes: 0,
  sidebar_field_remeasures: 0,
  sidebar_thin_frame_peeks: 0,
};

export const QUICK_PEEK_CLOSE_MS = 500;
export const FRAME_UNDER_OLD_PEEK_GAP = 4;
let counts = { ...NONE };

export function noteSidebarSlide(pastTarget: boolean) {
  counts.sidebar_slides++;
  if (pastTarget) counts.sidebar_slides_past_target++;
}

export const noteSidebarPeekRevealHeldBack = () => void counts.sidebar_peek_reveals_held_back++;

export const notePageFullScreenPeek = () => void counts.sidebar_page_full_screen_peeks++;

export const noteSidebarPeekResize = () => void counts.sidebar_peek_resizes++;

export const noteSidebarPeekClosedWhileResizing = () => void counts.sidebar_peek_closes_while_resizing++;

const SCREEN_EDGE_COUNTS = {
  crossed: "sidebar_screen_edge_crossings",
  returned: "sidebar_screen_edge_returns",
} as const satisfies Record<ScreenEdge, keyof typeof NONE>;

export const noteSidebarScreenEdge = (edge: ScreenEdge) => void counts[SCREEN_EDGE_COUNTS[edge]]++;

export const noteFullScreenPeek = () => void counts.sidebar_full_screen_peeks++;

export const noteFullScreenPeekClosed = (shownMs: number) => void (shownMs < QUICK_PEEK_CLOSE_MS && counts.sidebar_full_screen_peek_quick_closes++);

export const noteSidebarPeekFrame = (frameInset: number) => void (frameInset < FRAME_UNDER_OLD_PEEK_GAP && counts.sidebar_thin_frame_peeks++);

export const noteSidebarFieldRemeasure = () => void counts.sidebar_field_remeasures++;

export function takeDockCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
