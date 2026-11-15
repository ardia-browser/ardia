import { memo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { FadeLabel, perLook, radius, sidebarLineHeight, Surface, type SurfaceProps } from "../ui";
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
  const theme = useTheme();
  const glow = useSelectedTabGlow();
  return (
    <Surface
      fill={hex(fill)}
      cornerRadius={cornerRadius}
      borderWidth={border}
      borderColor={stroke === undefined ? undefined : hex(stroke)}
      borderColors={selected ? theme.tabSelectedBorder.map(hex) : undefined}
      shadowColor={selected ? glow.shadowColor : undefined}
      shadowOpacity={selected ? glow.shadowOpacity : 0}
      shadowRadius={glow.shadowRadius}
      shadowOffset={SELECTED_ROW_SHADOW_OFFSET}
      style={{ height: layout.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: padLeft, paddingRight: padRight }}
    >
      {children}
    </Surface>
  );
}

export const SidebarRowLabel = memo(function SidebarRowLabel({ text, color, weight, compact = false, struck = false }: { text: string; color: string; weight?: "medium" | "regular"; compact?: boolean; struck?: boolean }) {
  useTheme();
  const frame = compact ? compactTitleFrame() : rowTitleFrame();
  return <FadeLabel text={text} fontSize={compact ? SIDEBAR_TYPE.compact : SIDEBAR_TYPE.title} weight={weight} color={color} strikethrough={struck} style={struck ? [frame, SLEEPING_TITLE] : frame} />;
});

const SLEEPING_TITLE = { opacity: SLEEPING_TITLE_OPACITY } as const;

export function SidebarListRow({ height, fill, padRight = 0, style, children }: { height: number; fill?: string; padRight?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <View
      style={[
        { height, borderRadius: radius.tile, flexDirection: "row", alignItems: "center", paddingLeft: TAB_ROW.contentLeft, paddingRight: padRight, backgroundColor: fill },
        style,
      ]}
    >
      {children}
    </View>
  );
}
