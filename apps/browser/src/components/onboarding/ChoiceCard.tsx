import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { GlassFill, ink, Panel, useGlass } from "../ui";
import { useTheme } from "../ui/theme";
import { onboardingColorsOf, onboardingTile } from "./tokens";

export const CARD_BORDER = StyleSheet.hairlineWidth * 2;
export const SELECTED_BORDER = CARD_BORDER;
const DASHED_BORDER = 1;

type ChoiceCardProps = Omit<ViewProps, "style"> & {
  radius: number;
  selected?: boolean;
  hovered?: boolean;
  raised?: boolean;
  dashed?: boolean;
  plain?: boolean;
  outline?: "strong" | "soft";
  fill?: string;
  border?: string | null;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

export function ChoiceCard({
  radius,
  selected = false,
  hovered = false,
  raised = selected,
  dashed = false,
  plain = false,
  outline = "strong",
  fill,
  border,
  style,
  children,
  ...rest
}: ChoiceCardProps) {
  const colors = onboardingColorsOf(useTheme());
  const glass = useGlass() && !plain && !dashed;
  const lit = selected || hovered;
  const borderWidth = border === null ? 0 : dashed ? DASHED_BORDER : CARD_BORDER;
  const borderColor = border ?? (selected && outline === "strong" ? colors.tileBorderSelected : colors.tileBorder);
  const surface = fill ?? (plain ? colors.row : lit ? colors.tileLit : colors.tile);
  if (glass)
    return (
      <View {...rest} style={[{ borderRadius: radius, backgroundColor: ink.clear, borderWidth, borderColor }, style]}>
        <GlassFill radius={radius} border={borderWidth} state={raised ? "active" : "rest"} />
        {lit ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", top: -borderWidth, left: -borderWidth, right: -borderWidth, bottom: -borderWidth, borderRadius: radius, borderCurve: "continuous", backgroundColor: colors.outlinedHover }}
          />
        ) : null}
        {children}
      </View>
    );
  if (plain || dashed || border === null)
    return (
      <View {...rest} style={[{ borderRadius: radius, backgroundColor: surface, borderWidth, borderColor, borderStyle: dashed ? "dashed" : undefined }, style]}>
        {children}
      </View>
    );
  return (
    <Panel {...rest} fill={surface} radius={radius} border={borderColor} borderWidth={borderWidth} shadow={selected ? onboardingTile.selectedShadow : onboardingTile.shadow} style={style}>
      {children}
    </Panel>
  );
}
