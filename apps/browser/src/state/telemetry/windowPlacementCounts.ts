import { onAppEvent } from "../../platform/app";
import type { FullScreenTransition } from "../../platform/media";
import { isSharing } from "./choice";
import { counted, type ConsentToken } from "./client";
import { nativeConsent } from "./nativeConsent";

let centeredResizes = 0;
let reopenedMaximized = 0;
let titlesRead = 0;
let closePinsKept = 0;
let closePinIdsRenewed = 0;
let dragLoops = 0;
let littleOpenedFloating = 0;
let utilityOpenedFloating = 0;
let nativeDrags = 0;
let dragTakeovers = 0;
let pageFullScreenStarts = 0;
let pageFullScreenSlowStarts = 0;
export const SLOW_PAGE_FULL_SCREEN_START_MS = 300;
const NO_LINUX_COUNTS = {
  linux_windows_app_decorated: 0,
  linux_windows_compositor_decorated: 0,
  linux_decoration_answers_none: 0,
  linux_decoration_answers_client: 0,
  linux_decoration_answers_server: 0,
  linux_page_viewports_rejected: 0,
};
let linuxCounts = { ...NO_LINUX_COUNTS };
const LINUX_DECORATED_BY = { app: "linux_windows_app_decorated", compositor: "linux_windows_compositor_decorated" } as const;
const LINUX_DECORATION_ANSWERS = { none: "linux_decoration_answers_none", client: "linux_decoration_answers_client", server: "linux_decoration_answers_server" } as const;

onAppEvent((e) => {
  if (
    e.type !== "centeredResize" && e.type !== "windowTitleRead" && e.type !== "windowDragLoop" && e.type !== "windowDragNative" &&
    e.type !== "windowDragTakeover"
  ) return;
  const { type } = e;
  counted(
    nativeConsent(e),
    () => {
      if (type === "centeredResize") centeredResizes++;
      else if (type === "windowTitleRead") titlesRead++;
      else if (type === "windowDragNative") nativeDrags++;
      else if (type === "windowDragTakeover") dragTakeovers++;
      else dragLoops++;
    },
  );
});

export function notePageFullScreenTransition(transition: FullScreenTransition | null) {
  if (!transition?.entering) return;
  const slow = transition.waitedMs >= SLOW_PAGE_FULL_SCREEN_START_MS;
  counted(nativeConsent(transition), () => {
    pageFullScreenStarts++;
    if (slow) pageFullScreenSlowStarts++;
  });
}

export const noteWindowReopenedMaximized = () => void (isSharing() && reopenedMaximized++);
export function noteWindowClosePinsKept(n: number, renewed: number) {
  closePinsKept += n;
  closePinIdsRenewed += renewed;
}

export function noteLinuxWindowDecorations(decoratedBy: unknown, answer: unknown) {
  if (!isSharing()) return;
  if (typeof decoratedBy === "string" && Object.hasOwn(LINUX_DECORATED_BY, decoratedBy)) linuxCounts[LINUX_DECORATED_BY[decoratedBy as keyof typeof LINUX_DECORATED_BY]]++;
  if (typeof answer === "string" && Object.hasOwn(LINUX_DECORATION_ANSWERS, answer)) linuxCounts[LINUX_DECORATION_ANSWERS[answer as keyof typeof LINUX_DECORATION_ANSWERS]]++;
}

export const noteLinuxPageViewportRejected = (consent: ConsentToken | null) => counted(consent, () => void linuxCounts.linux_page_viewports_rejected++);

export function noteWindowOpenedFloating(little: boolean, consent: ConsentToken | null) {
  counted(consent, () => (little ? littleOpenedFloating++ : utilityOpenedFloating++));
}

export function takeWindowPlacementCounts() {
  const taken = { window_centered_resizes: centeredResizes, windows_reopened_maximized: reopenedMaximized, window_titles_read: titlesRead, window_drag_loops: dragLoops, window_drags_native: nativeDrags, window_drag_takeovers: dragTakeovers, window_close_pins_kept: closePinsKept, window_close_pin_ids_renewed: closePinIdsRenewed, little_ardia_opened_floating: littleOpenedFloating, utility_windows_opened_floating: utilityOpenedFloating, page_full_screen_starts: pageFullScreenStarts, page_full_screen_slow_starts: pageFullScreenSlowStarts, ...linuxCounts };
  linuxCounts = { ...NO_LINUX_COUNTS };
  centeredResizes = 0;
  reopenedMaximized = 0;
  pageFullScreenStarts = 0;
  pageFullScreenSlowStarts = 0;
  titlesRead = 0;
  dragLoops = 0;
  nativeDrags = 0;
  dragTakeovers = 0;
  closePinsKept = 0;
  closePinIdsRenewed = 0;
  littleOpenedFloating = 0;
  utilityOpenedFloating = 0;
  return taken;
}
