import { useState } from "react";
import { Pressable, type GestureResponderEvent, type ViewStyle } from "react-native";
import { continuousCorners, drawnSymbol, iconButton, radius as radii, useOffstage, useTooltip } from "../ui";
import { useTheme } from "../ui/theme";
import { useTabCloseControlWhile } from "../../state/sidebar/closeControl";

export function RowCloseButton({
  tabId,
  icon,
  tooltip,
  onPress,
  box = iconButton.s.box,
  radius = radii.control,
  style,
}: {
  tabId?: string;
  icon?: string;
  tooltip?: string;
  onPress: (event: GestureResponderEvent) => void;
  box?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const control = useTabCloseControlWhile(tabId ?? "", !!tabId);
  const label = control?.tooltip ?? tooltip ?? "";
  const tip = useTooltip(label);
  const offstage = useOffstage();
  const [pointed, setPointed] = useState(false);
  const hovered = pointed && !offstage;
  return (
    <Pressable
      tooltip={tip}
      onPress={onPress}
      onHoverIn={() => setPointed(true)}
      onHoverOut={() => setPointed(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [style, { width: box, height: box, ...continuousCorners(radius), alignItems: "center", justifyContent: "center" }, pressed || hovered ? { backgroundColor: pressed ? theme.toolbarPressed : theme.toolbarHover } : null]}
    >
      {drawnSymbol({ name: control?.icon ?? icon ?? "xmark", size: iconButton.s.glyph, weight: "semibold", color: theme.icon, style: { width: box, height: box } })}
    </Pressable>
  );
}
