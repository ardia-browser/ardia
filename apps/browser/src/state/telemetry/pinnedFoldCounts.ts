import { isSharing, useTelemetry } from "./choice";

let collapses = 0;
let expands = 0;

useTelemetry.subscribe((s, prev) => {
  if (prev.sharing && !s.sharing) collapses = expands = 0;
});

export function notePinnedFoldToggled(collapsed: boolean) {
  if (!isSharing()) return;
  if (collapsed) collapses++;
  else expands++;
}

export function takePinnedFoldCounts() {
  const taken = { pinned_section_collapses: collapses, pinned_section_expands: expands };
  collapses = expands = 0;
  return taken;
}
