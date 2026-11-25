import { memo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { iconButton } from "../ui/tokens";
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
  const status = children != null && children !== false;
  return (
    <>
      {status ? (
        <View style={hovered ? STATUS_ROOM : STATUS_FRAME}>
          <View pointerEvents={hovered ? "none" : "box-none"} style={hovered ? STATUS_UNDER_CLOSE : STATUS}>
            {children}
          </View>
        </View>
      ) : null}
      {hovered ? <RowCloseButton tabId={tabId} style={status ? OVER_STATUS : undefined} onPress={() => pressTabClose(tabId)} /> : null}
    </>
  );
});

const STATUS_FRAME = { alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "flex-end" } as const;
const STATUS_ROOM = { ...STATUS_FRAME, minWidth: iconButton.s.box } as const;
const STATUS = { flexDirection: "row", alignItems: "center" } as const;
const STATUS_UNDER_CLOSE = { ...STATUS, opacity: 0 } as const;
const OVER_STATUS = { marginLeft: -iconButton.s.box } as const;
