import { memo, useContext, useMemo, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { continuousCorners, drawnFadeLabel, perLook, radius, sidebarLineHeight, Surface, TextScopeContext, type SurfaceProps } from "../ui";
import { hex, layout, useTheme } from "../ui/theme";
import { useSelectedTabGlow } from "./rowLook";
import { SELECTED_ROW_SHADOW_OFFSET, SIDEBAR_TYPE, SLEEPING_TITLE_OPACITY, TAB_ROW } from "./tokens";

export const rowTitleFrame = perLook(() => ({ flex: 1, height: Math.max(TAB_ROW.titleHeight, sidebarLineHeight.body + 2), marginLeft: TAB_ROW.titleGap }));

const compactTitleFrame = perLook(() => ({ flex: 1, height: Math.max(TAB_ROW.compactTitleHeight, sidebarLineHeight.small + 2), marginLeft: TAB_ROW.titleGap }));

export function SidebarRowSurface({
  fill,
  selected = false,
  border = 0,
  stroke,
  cornerRadius = radius.chrome,
  padLeft = TAB_ROW.contentLeft,
  padRight = TAB_ROW.trailing,
  children,
}: {
  fill: string;
  selected?: boolean;
  border?: number;
  stroke?: string;
  cornerRadius?: number;
  padLeft?: number;
  padRight?: number;
  children: SurfaceProps["children"];
}) {
  const surface = useRowSurfaceLayer({ fill, selected, border, stroke, cornerRadius });
  return (
    <View style={rowSurfaceFrame(padLeft, padRight)}>
      {surface}
      {children}
    </View>
  );
}

const surfaceFrames = new Map<string, ViewStyle>();

export function rowSurfaceFrame(padLeft: number = TAB_ROW.contentLeft, padRight: number = TAB_ROW.trailing): ViewStyle {
  const key = `${layout.rowHeight}:${padLeft}:${padRight}`;
  let frame = surfaceFrames.get(key);
  if (!frame) surfaceFrames.set(key, (frame = { height: layout.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: padLeft, paddingRight: padRight }));
  return frame;
}

export function useRowSurfaceLayer({
  fill,
  selected = false,
  border = 0,
  stroke,
  cornerRadius = radius.chrome,
}: {
  fill: string;
  selected?: boolean;
  border?: number;
  stroke?: string;
  cornerRadius?: number;
}) {
  const theme = useTheme();
  const { shadowColor, shadowOpacity, shadowRadius } = useSelectedTabGlow();
  const selectedBorder = theme.tabSelectedBorder;
  return useMemo(
    () => (
      <Surface
        pointerEvents="none"
        fill={hex(fill)}
        cornerRadius={cornerRadius}
        borderWidth={border}
        borderColor={stroke === undefined ? undefined : hex(stroke)}
        borderColors={selected ? selectedBorder.map(hex) : undefined}
        shadowColor={selected ? shadowColor : undefined}
        shadowOpacity={selected ? shadowOpacity : 0}
        shadowRadius={shadowRadius}
        shadowOffset={SELECTED_ROW_SHADOW_OFFSET}
        style={StyleSheet.absoluteFill}
      />
    ),
    [fill, cornerRadius, border, stroke, selected, selectedBorder, shadowColor, shadowOpacity, shadowRadius],
  );
}

export const SidebarRowLabel = memo(function SidebarRowLabel({ text, color, weight, compact = false, struck = false }: { text: string; color: string; weight?: "medium" | "regular"; compact?: boolean; struck?: boolean }) {
  useTheme();
  const inSidebar = useContext(TextScopeContext) === "sidebar";
  const frame = compact ? compactTitleFrame() : rowTitleFrame();
  return drawnFadeLabel({ text, fontSize: compact ? SIDEBAR_TYPE.compact : SIDEBAR_TYPE.title, weight, color, strikethrough: struck, style: struck ? [frame, SLEEPING_TITLE] : frame }, inSidebar);
});

const SLEEPING_TITLE = { opacity: SLEEPING_TITLE_OPACITY } as const;

export function SidebarListRow({ height, fill, padRight = 0, style, children }: { height: number; fill?: string; padRight?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <View
      style={[
        { height, ...continuousCorners(radius.tile), flexDirection: "row", alignItems: "center", paddingLeft: TAB_ROW.contentLeft, paddingRight: padRight, backgroundColor: fill },
        style,
      ]}
    >
      {children}
    </View>
  );
}
