import { onAppEvent } from "../../platform/app";

let centeredResizes = 0;
let reopenedMaximized = 0;

onAppEvent((e) => {
  if (e.type === "centeredResize") centeredResizes++;
});

export const noteWindowReopenedMaximized = () => void reopenedMaximized++;

export function takeWindowPlacementCounts() {
  const taken = { window_centered_resizes: centeredResizes, windows_reopened_maximized: reopenedMaximized };
  centeredResizes = 0;
  reopenedMaximized = 0;
  return taken;
}
