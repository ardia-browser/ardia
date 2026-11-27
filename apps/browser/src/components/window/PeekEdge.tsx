import { Animated } from "react-native";
import { hairline } from "../ui";
import { useTheme } from "../ui/theme";

export function PeekEdge({ side, bleed, right, radius, shown }: { side: "left" | "right"; bleed: number; right: boolean; radius: number; shown: Animated.Value }) {
  const theme = useTheme();
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: -bleed,
        [right ? "left" : "right"]: 0,
        borderRadius: radius,
        borderWidth: hairline.panel,
        borderColor: theme.panelBorder,
        opacity: shown,
      }}
    />
  );
}
