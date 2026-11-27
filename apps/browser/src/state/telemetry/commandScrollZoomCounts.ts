import { consentOrNow, countFor } from "./countFor";

const empty = () => ({ command_scroll_zoom_steps: 0, command_scroll_zoom_merged_steps: 0 });
let counts = empty();

export const noteCommandScrollZoom = (scroll: string | undefined) => {
  if (scroll !== "wheel" && scroll !== "merged") return;
  countFor(consentOrNow(undefined), () => {
    counts.command_scroll_zoom_steps++;
    if (scroll === "merged") counts.command_scroll_zoom_merged_steps++;
  });
};

export function takeCommandScrollZoomCounts() {
  const taken = counts;
  counts = empty();
  return taken;
}
