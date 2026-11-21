import { onAppEvent } from "../../platform/app";
import { isSharing } from "./choice";
import { capture, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let centeredResizes = 0;
let reopenedMaximized = 0;
let titlesRead = 0;
let dragLoops = 0;

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
    () => capture("usage_counts", { [FIELDS[type]]: 1 }, null),
  );
});

export const noteWindowReopenedMaximized = () => void (isSharing() && reopenedMaximized++);

export function takeWindowPlacementCounts() {
  const taken = { window_centered_resizes: centeredResizes, windows_reopened_maximized: reopenedMaximized, window_titles_read: titlesRead, window_drag_loops: dragLoops };
  centeredResizes = 0;
  reopenedMaximized = 0;
  titlesRead = 0;
  dragLoops = 0;
  return taken;
}
