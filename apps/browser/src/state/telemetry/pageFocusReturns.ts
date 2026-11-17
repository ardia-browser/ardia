import type { FocusRestoreOutcome } from "../../platform/tabs";
import { isSharing, useTelemetry } from "./choice";

const empty = () => ({
  page_focus_returns_after_bar: 0,
  page_focus_return_requests_after_menu: 0,
  webkit_focus_restores: 0,
  webkit_focus_restores_kept: 0,
  webkit_focus_restores_refused: 0,
  webkit_focus_restores_gave_up: 0,
});

let counts = empty();

export const notePageFocusReturnAfterBar = () => void counts.page_focus_returns_after_bar++;

useTelemetry.subscribe((state) => {
  if (!state.sharing) counts.page_focus_return_requests_after_menu = 0;
});

export function notePageFocusReturnRequestAfterMenu() {
  if (isSharing()) counts.page_focus_return_requests_after_menu++;
}

const RESTORE_COUNT = {
  focused: "webkit_focus_restores",
  kept: "webkit_focus_restores_kept",
  refused: "webkit_focus_restores_refused",
  gaveUp: "webkit_focus_restores_gave_up",
} as const;

export function noteWebKitFocusRestore(outcome: FocusRestoreOutcome) {
  if (outcome !== "unknown") counts[RESTORE_COUNT[outcome]]++;
}

export function takePageFocusReturns() {
  const taken = counts;
  counts = empty();
  return taken;
}
