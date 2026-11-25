import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { Button, clippedContinuousCorners, continuousCorners, type IconPalette } from "../ui";
import { useTheme } from "../ui/theme";
import { GlassFill, useGlass } from "../ui/Glass";
import { SIDEBAR_FIELD, SIDEBAR_FIELD_CONTROL } from "./geometry";
import { useSidebarTokens } from "./tokens";

const FIELD_BORDER = StyleSheet.hairlineWidth;

export const SidebarFieldFill = memo(function SidebarFieldFill({
  hovered,
}: {
  hovered: boolean;
}) {
  const theme = useTheme();
  if (useGlass()) {
    return (
      <GlassFill state={hovered ? "lit" : "rest"} radius={SIDEBAR_FIELD.radius} />
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          ...clippedContinuousCorners(SIDEBAR_FIELD.radius),
          borderWidth: FIELD_BORDER,
          borderColor: theme.pinnedRestingStroke,
          backgroundColor: hovered ? theme.tabHover : theme.pinnedResting,
        },
      ]}
    />
  );
});

export function FieldSiteButton({
  icon,
  color,
  tooltip,
  active,
  palette,
  onPress,
}: {
  icon: string;
  color?: string;
  tooltip: string;
  active: boolean;
  palette: IconPalette;
  onPress: () => void;
}) {
  const tokens = useSidebarTokens();
  return (
    <Button
      style={{
        marginLeft: SIDEBAR_FIELD_CONTROL.inset,
        width: SIDEBAR_FIELD_CONTROL.box,
        height: SIDEBAR_FIELD_CONTROL.box,
        ...continuousCorners(SIDEBAR_FIELD_CONTROL.radius),
        backgroundColor: tokens.fieldButtonPlate,
      }}
      variant="icon"
      toolbar
      palette={palette}
      icon={icon}
      color={color}
      look="field"
      box={SIDEBAR_FIELD_CONTROL.box}
      radius={SIDEBAR_FIELD_CONTROL.radius}
      active={active}
      onPress={onPress}
      tooltip={tooltip}
    />
  );
}
