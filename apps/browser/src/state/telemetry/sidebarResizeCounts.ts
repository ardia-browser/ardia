import { takeFoldMotionCounts } from "./foldMotion";
import { takeSidebarScrollCounts } from "./sidebarScrollCounts";

let resizes = 0;

export function noteSidebarResize() {
  resizes++;
}

export function takeSidebarResizeCounts() {
  const taken = { sidebar_resizes: resizes, ...takeSidebarScrollCounts(), ...takeFoldMotionCounts() };
  resizes = 0;
  return taken;
}
