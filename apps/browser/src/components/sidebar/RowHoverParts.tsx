import { memo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { hoverSlotView } from "../ui/HoverSlot";
import { pressTabClose } from "../../state/sidebar/closeControl";
import { useCellHovered, type RowHoverCell } from "./hoverController";
import { RowCloseButton } from "./RowCloseButton";

export const RowHoverFill = memo(function RowHoverFill({ cell, pressed, color, radius }: { cell: RowHoverCell; pressed: boolean; color: string; radius: number }) {
  const hovered = useCellHovered(cell);
  if (!cell.plain || !(hovered || pressed)) return null;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: color }]} />;
});

export const RowCloseSlot = memo(function RowCloseSlot({ cell, tabId, renaming, children }: { cell: RowHoverCell; tabId: string; renaming: boolean; children?: ReactNode }) {
  const hovered = useCellHovered(cell) && !renaming;
  return hoverSlotView({ hovered, reserve: "hover", hover: hovered ? <RowCloseButton tabId={tabId} onPress={() => pressTabClose(tabId)} /> : null, children });
});
