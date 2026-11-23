import type { SplitSide } from "../splits/splits";
import { consentOrNow, countFor } from "./countFor";
import type { ConsentToken } from "./consentPeriod";

const none = () => ({
  horizontalDrops: 0,
  verticalDrops: 0,
  horizontalOpens: 0,
  dragSwaps: 0,
  dragCancels: 0,
  keyMoves: 0,
  menuMoves: 0,
});

let counts = none();

const bump = (key: keyof ReturnType<typeof none>, consent?: ConsentToken | null) =>
  countFor(consentOrNow(consent), () => void counts[key]++);

export const noteSplitDrop = (side: SplitSide, consent?: ConsentToken | null) =>
  bump(side === "top" || side === "bottom" ? "horizontalDrops" : "verticalDrops", consent);

export const noteHorizontalSplitOpen = (consent?: ConsentToken | null) => bump("horizontalOpens", consent);

export const noteSplitPaneMove = (via: "drag" | "keyboard" | "menu", consent?: ConsentToken | null) =>
  bump(via === "drag" ? "dragSwaps" : via === "keyboard" ? "keyMoves" : "menuMoves", consent);

export const noteSplitPaneDragCancel = (consent?: ConsentToken | null) => bump("dragCancels", consent);

export function takeSplitReorderCounts() {
  const taken = counts;
  counts = none();
  return {
    split_horizontal_drops: taken.horizontalDrops,
    split_vertical_drops: taken.verticalDrops,
    split_horizontal_opens: taken.horizontalOpens,
    split_pane_drag_swaps: taken.dragSwaps,
    split_pane_drag_cancels: taken.dragCancels,
    split_pane_key_moves: taken.keyMoves,
    split_pane_menu_moves: taken.menuMoves,
  };
}
