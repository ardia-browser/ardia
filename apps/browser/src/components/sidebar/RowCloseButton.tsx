import { useState } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";
import { iconButton, radius as radii, Symbol, useOffstage, useTooltip } from "../ui";
import { useTheme } from "../ui/theme";
import { useTabCloseControlWhile } from "../../state/sidebar/closeControl";

export function RowCloseButton({
  tabId,
  icon,
  tooltip,
  onPress,
  box = iconButton.s.box,
  radius = radii.control,
}: {
  tabId?: string;
  icon?: string;
  tooltip?: string;
  onPress: (event: GestureResponderEvent) => void;
  box?: number;
  radius?: number;
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
      style={({ pressed }) => [{ width: box, height: box, borderRadius: radius, alignItems: "center", justifyContent: "center" }, pressed || hovered ? { backgroundColor: pressed ? theme.toolbarPressed : theme.toolbarHover } : null]}
    >
      <Symbol name={control?.icon ?? icon ?? "xmark"} size={iconButton.s.glyph} weight="semibold" color={theme.icon} style={{ width: box, height: box }} />
    </Pressable>
  );
}
