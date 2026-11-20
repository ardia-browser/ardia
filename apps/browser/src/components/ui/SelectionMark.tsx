import { View } from "react-native";
import { isLight, over, toContrast } from "../../lib/color";
import { useTheme } from "./theme";
import { SELECTION_MARK } from "./tokens";

export function selectionMarkColor(fill: string, backdrop: string): string {
  const under = over(fill, backdrop);
  return toContrast(isLight(under) ? SELECTION_MARK.light : SELECTION_MARK.dark, under, SELECTION_MARK.contrast);
}

export function SelectionMark({ fill, backdrop }: { fill: string; backdrop?: string }) {
  const theme = useTheme();
  const color = selectionMarkColor(fill, backdrop ?? theme.windowTint[0]);
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", left: SELECTION_MARK.inset, top: SELECTION_MARK.vertical, bottom: SELECTION_MARK.vertical, width: SELECTION_MARK.width, borderRadius: SELECTION_MARK.width / 2, backgroundColor: color }}
    />
  );
}
