import { takePinnedFoldCounts } from "./pinnedFoldCounts";
import { takeSidebarScrollCounts } from "./sidebarScrollCounts";

let resizes = 0;

export function noteSidebarResize() {
  resizes++;
}

export function takeSidebarResizeCounts() {
  const taken = { sidebar_resizes: resizes, ...takeSidebarScrollCounts(), ...takePinnedFoldCounts() };
  resizes = 0;
  return taken;
}
