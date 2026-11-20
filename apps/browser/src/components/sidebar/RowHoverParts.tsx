import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { hoverSlotView } from "../ui/HoverSlot";
import { pressTabClose, useTabCloseControlWhile } from "../../state/sidebar/closeControl";
import { useCellHovered, type RowHoverCell } from "./hoverController";
import { RowCloseButton } from "./RowCloseButton";

export function RowHoverFill({ cell, plain, pressed, color, radius }: { cell: RowHoverCell; plain: boolean; pressed: boolean; color: string; radius: number }) {
  const hovered = useCellHovered(cell);
  if (!plain || !(hovered || pressed)) return null;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: color }]} />;
}

export function RowCloseSlot({ cell, tabId, renaming, children }: { cell: RowHoverCell; tabId: string; renaming: boolean; children?: ReactNode }) {
  const hovered = useCellHovered(cell) && !renaming;
  const closeControl = useTabCloseControlWhile(tabId, hovered);
  return hoverSlotView({ hovered, reserve: "hover", hover: closeControl && <RowCloseButton icon={closeControl.icon} tooltip={closeControl.tooltip} onPress={() => pressTabClose(tabId)} />, children });
}
