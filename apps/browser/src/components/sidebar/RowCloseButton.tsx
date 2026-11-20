import { useState } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";
import { iconButton, radius as radii, Symbol, useOffstage, useTooltip } from "../ui";
import { useTheme } from "../ui/theme";

export function RowCloseButton({
  icon,
  tooltip,
  onPress,
  box = iconButton.s.box,
  radius = radii.control,
}: {
  icon: string;
  tooltip: string;
  onPress: (event: GestureResponderEvent) => void;
  box?: number;
  radius?: number;
}) {
  const theme = useTheme();
  const tip = useTooltip(tooltip);
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
      accessibilityLabel={tooltip}
      style={({ pressed }) => [{ width: box, height: box, borderRadius: radius, alignItems: "center", justifyContent: "center" }, pressed || hovered ? { backgroundColor: pressed ? theme.toolbarPressed : theme.toolbarHover } : null]}
    >
      <Symbol name={icon} size={iconButton.s.glyph} weight="semibold" color={theme.icon} style={{ width: box, height: box }} />
    </Pressable>
  );
}
