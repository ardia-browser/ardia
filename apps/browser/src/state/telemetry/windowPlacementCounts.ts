import { onAppEvent } from "../../platform/app";
import { isSharing } from "./choice";
import { counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let centeredResizes = 0;
let reopenedMaximized = 0;
let titlesRead = 0;
let closePinsKept = 0;
let dragLoops = 0;
const NO_LINUX_DECORATIONS = {
  linux_windows_app_decorated: 0,
  linux_windows_compositor_decorated: 0,
  linux_decoration_answers_none: 0,
  linux_decoration_answers_client: 0,
  linux_decoration_answers_server: 0,
  linux_page_viewports_rejected: 0,
};
let linuxDecorations = { ...NO_LINUX_DECORATIONS };
const LINUX_DECORATED_BY = { app: "linux_windows_app_decorated", compositor: "linux_windows_compositor_decorated" } as const;
const LINUX_DECORATION_ANSWERS = { none: "linux_decoration_answers_none", client: "linux_decoration_answers_client", server: "linux_decoration_answers_server" } as const;

const FIELDS = { centeredResize: "window_centered_resizes", windowTitleRead: "window_titles_read", windowDragLoop: "window_drag_loops" } as const;

onAppEvent((e) => {
  if (e.type !== "centeredResize" && e.type !== "windowTitleRead" && e.type !== "windowDragLoop") return;
  const { type } = e;
  counted(
    nativeConsent(e),
    () => {
      if (type === "centeredResize") centeredResizes++;
      else if (type === "windowTitleRead") titlesRead++;
      else dragLoops++;
    },
  );
});

export const noteWindowReopenedMaximized = () => void (isSharing() && reopenedMaximized++);
export const noteWindowClosePinsKept = (n: number) => void (closePinsKept += n);

export function noteLinuxWindowDecorations(decoratedBy: unknown, answer: unknown) {
  if (!isSharing()) return;
  if (typeof decoratedBy === "string" && Object.hasOwn(LINUX_DECORATED_BY, decoratedBy)) linuxDecorations[LINUX_DECORATED_BY[decoratedBy as keyof typeof LINUX_DECORATED_BY]]++;
  if (typeof answer === "string" && Object.hasOwn(LINUX_DECORATION_ANSWERS, answer)) linuxDecorations[LINUX_DECORATION_ANSWERS[answer as keyof typeof LINUX_DECORATION_ANSWERS]]++;
}

export const noteLinuxPageViewportRejected = () => void (isSharing() && linuxDecorations.linux_page_viewports_rejected++);

export function takeWindowPlacementCounts() {
  const taken = { window_centered_resizes: centeredResizes, windows_reopened_maximized: reopenedMaximized, window_titles_read: titlesRead, window_drag_loops: dragLoops, window_close_pins_kept: closePinsKept, ...linuxDecorations };
  linuxDecorations = { ...NO_LINUX_DECORATIONS };
  centeredResizes = 0;
  reopenedMaximized = 0;
  titlesRead = 0;
  dragLoops = 0;
  closePinsKept = 0;
  return taken;
}
