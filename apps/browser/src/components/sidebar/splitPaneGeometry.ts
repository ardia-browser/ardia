import { layout } from "../ui/theme";
import { radius, space } from "../ui/tokens";

export const SPLIT_PANE = { inset: space.xs, gap: space.xs, closeInset: space.xxs } as const;
export const SPLIT_MAX_PANES = 3;

export function splitPaneShape() {
  const height = layout.rowHeight - SPLIT_PANE.inset * 2;
  const corner = Math.max(0, radius.chrome - SPLIT_PANE.inset);
  return { height, corner, closeBox: height - SPLIT_PANE.closeInset * 2, closeCorner: Math.max(0, corner - SPLIT_PANE.closeInset) };
}

export function previewSlots(width: number, panes: number) {
  const slots = panes + 1;
  const slot = (width - SPLIT_PANE.inset * 2 - SPLIT_PANE.gap * (slots - 1)) / slots;
  return { slot, pitch: slot + SPLIT_PANE.gap };
}
