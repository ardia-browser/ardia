import { useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { iconButton } from "./tokens";

const HOVER_SLOT_WIDTH = iconButton.s.box;

type SlotProps = {
  hovered: boolean;
  hover: ReactNode;
  reserve?: "always" | "hover";
  align?: "start" | "end";
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function HoverSlot({ width = HOVER_SLOT_WIDTH, ...props }: SlotProps & { width?: number | "content" }) {
  return width === "content" ? <ContentHoverSlot {...props} /> : hoverSlotView({ ...props, width });
}

function hoverSlotView({ hovered, hover, width = HOVER_SLOT_WIDTH, reserve = "always", align = "end", children, style }: SlotProps & { width?: number }) {
  const showHover = hovered && hover != null && hover !== false;
  const hasChildren = children != null && children !== false;
  if (reserve === "hover" && !showHover && !hasChildren && style === undefined) return null;
  return (
    <View style={[slotFrame(reserve === "always" || showHover ? width : 0, align), style]}>
      {hasChildren ? slotRest(showHover, children) : null}
      {showHover ? <View style={[HOVER_LAYER, align === "start" ? AT_START : AT_END]}>{hover}</View> : null}
    </View>
  );
}

function ContentHoverSlot({ hovered, hover, reserve = "always", align = "end", children, style }: SlotProps) {
  const [contentWidth, setContentWidth] = useState(0);
  const hasHover = hover != null && hover !== false;
  const showHover = hovered && hasHover;
  const hasChildren = children != null && children !== false;
  return (
    <View style={[slotFrame(reserve === "always" || showHover ? contentWidth : 0, align), style]}>
      {hasChildren ? slotRest(showHover, children) : null}
      {hasHover ? (
        <View onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)} style={[HOVER_LAYER, align === "start" ? AT_START : AT_END, { opacity: showHover ? 1 : 0 }]}>
          {hover}
        </View>
      ) : null}
    </View>
  );
}

function slotRest(showHover: boolean, children: ReactNode) {
  return (
    <View pointerEvents={showHover ? "none" : "box-none"} style={{ flexDirection: "row", alignItems: "center", opacity: showHover ? 0 : 1 }}>
      {children}
    </View>
  );
}

const slotFrame = (minWidth: number, align: "start" | "end") =>
  ({ minWidth, alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: align === "start" ? "flex-start" : "flex-end" }) as const;
const HOVER_LAYER = { position: "absolute", top: 0, bottom: 0, flexDirection: "row", alignItems: "center" } as const;
const AT_START = { left: 0 } as const;
const AT_END = { right: 0 } as const;
