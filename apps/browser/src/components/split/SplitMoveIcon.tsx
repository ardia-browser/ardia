import { SvgIcon } from "../ui";

const SPLIT_MOVE_SVG: string = require("../../../assets/split-move.svg");

export function SplitMoveIcon({ size, color }: { size: number; color: string }) {
  return <SvgIcon svg={SPLIT_MOVE_SVG} color={color} style={{ width: size, height: size }} />;
}
