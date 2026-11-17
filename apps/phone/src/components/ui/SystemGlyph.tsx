import { Host, Image as SystemImage } from "@expo/ui/swift-ui";
import { font as systemFont } from "@expo/ui/swift-ui/modifiers";
import { Platform, StyleSheet, View } from "react-native";
import { settingsUI } from "@ardia/phone-native";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";

export type SystemGlyphWeight = "regular" | "medium" | "semibold" | "bold";

type Props = {
  systemName: string;
  pointSize: number;
  weight?: SystemGlyphWeight;
  name: SymbolName;
  size: number;
  color: string;
  fitted?: boolean;
  testID?: string;
};

export const systemGlyphsAvailable = () => Platform.OS === "ios" && settingsUI.settingsUIAvailable();

export function SystemGlyph({ systemName, pointSize, weight = "regular", name, size, color, fitted = false, testID }: Props) {
  if (!systemGlyphsAvailable()) return <Symbol name={name} size={size} color={color} />;
  return (
    <View testID={testID} pointerEvents="none" style={fitted ? styles.box : [styles.box, { width: size, height: size }]}>
      <Host matchContents>
        <SystemImage systemName={systemName as never} color={color} modifiers={[systemFont({ size: pointSize, weight })]} />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
});
