import { Host, Image as SystemImage } from "@expo/ui/swift-ui";
import { Platform, StyleSheet, View } from "react-native";
import { settingsUIAvailable, Symbol } from "../ui";

const SF_SHARE = 0.92;

export function NotSecureLock({ size, color, testID }: { size: number; color: string; testID?: string }) {
  const box = { width: size, height: size };
  if (Platform.OS === "ios" && settingsUIAvailable()) {
    return (
      <View testID={testID} pointerEvents="none" style={[styles.box, box]}>
        <Host matchContents>
          <SystemImage systemName="lock.open.fill" size={size * SF_SHARE} color={color} />
        </Host>
      </View>
    );
  }
  return (
    <View testID={testID} pointerEvents="none" style={[styles.box, box]}>
      <Symbol name="lockOpenFill" size={size} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
});
