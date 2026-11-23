import { tintedImage } from "../ui";

const SPLIT_MOVE_ICON = require("../../../assets/split-move.png");

export function SplitMoveIcon({ size, color }: { size: number; color: string }) {
  return tintedImage({ source: SPLIT_MOVE_ICON, tint: color, identity: "split-move", style: { width: size, height: size } });
}
