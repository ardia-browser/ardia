import { useEffect, useState, type ReactNode } from "react";
import { Animated, View, type StyleProp, type ViewStyle } from "react-native";
import { iconButton } from "./tokens";
import { hoverFade } from "./motion";
import { reduceMotion } from "./reduceMotion";

const HOVER_SLOT_WIDTH = iconButton.s.box;

function Appear({ style, children }: { style: ViewStyle; children: ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(reduceMotion() === false ? 0 : 1));
  useEffect(() => {
    const fade = Animated.timing(opacity, { toValue: 1, ...hoverFade.appear, useNativeDriver: true });
    fade.start();
    return () => fade.stop();
  }, [opacity]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}

export function HoverSlot({
  hovered,
  hover,
  width = HOVER_SLOT_WIDTH,
  reserve = "always",
  align = "end",
  children,
  style,
}: {
  hovered: boolean;
  hover: ReactNode;
  width?: number | "content";
  reserve?: "always" | "hover";
  align?: "start" | "end";
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [contentWidth, setContentWidth] = useState(0);
  const fitsContent = width === "content";
  const room = fitsContent ? contentWidth : width;
  const hasHover = hover != null && hover !== false;
  const showHover = hovered && hasHover;
  const edge = align === "start" ? { left: 0 } : { right: 0 };
  const hasChildren = children != null && children !== false;
  if (reserve === "hover" && !fitsContent && !showHover && !hasChildren && style === undefined) return null;
  return (
    <View
      style={[
        { minWidth: reserve === "always" || showHover ? room : 0, alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: align === "start" ? "flex-start" : "flex-end" },
        style,
      ]}
    >
      {hasChildren ? (
        <View pointerEvents={showHover ? "none" : "box-none"} style={{ flexDirection: "row", alignItems: "center", opacity: showHover ? 0 : 1 }}>
          {children}
        </View>
      ) : null}
      {fitsContent && hasHover ? (
        <View
          onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)}
          style={{ position: "absolute", top: 0, bottom: 0, ...edge, flexDirection: "row", alignItems: "center", opacity: showHover ? 1 : 0 }}
        >
          {hover}
        </View>
      ) : showHover ? (
        <Appear style={{ position: "absolute", top: 0, bottom: 0, ...edge, flexDirection: "row", alignItems: "center" }}>{hover}</Appear>
      ) : null}
    </View>
  );
}
