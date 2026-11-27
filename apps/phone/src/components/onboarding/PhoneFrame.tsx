import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { smoothCorners } from "../ui";
import { phoneFrame } from "./onboardingTokens";

export const PHONE_SCREEN = { width: phoneFrame.width - 2 * phoneFrame.bezel, height: phoneFrame.height - 2 * phoneFrame.bezel } as const;

export function PhoneFrame({ children, screenColor = phoneFrame.screen, style }: { children: ReactNode; screenColor?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View testID="phoneFrame" style={[styles.body, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.screen, { backgroundColor: screenColor }]}>
        {children}
        <View pointerEvents="none" style={styles.status}>
          <Text style={styles.time}>9:41</Text>
          <View style={styles.island} />
          <View style={styles.glyphs}>
            <View style={styles.bars} />
            <View style={styles.battery} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    width: phoneFrame.width,
    height: phoneFrame.height,
    borderRadius: phoneFrame.radius,
    ...smoothCorners,
    backgroundColor: phoneFrame.bezelColor,
    padding: phoneFrame.bezel,
    boxShadow: phoneFrame.shadow,
  },
  screen: { flex: 1, borderRadius: phoneFrame.radius - phoneFrame.bezel, ...smoothCorners, overflow: "hidden" },
  status: { position: "absolute", top: 0, left: 0, right: 0, height: phoneFrame.statusHeight, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20 },
  time: { fontSize: 10, fontWeight: "600", color: phoneFrame.statusInk, width: 40 },
  island: { width: 52, height: 15, borderRadius: 8, backgroundColor: "#000000" },
  glyphs: { width: 40, flexDirection: "row", justifyContent: "flex-end", gap: 3 },
  bars: { width: 12, height: 7, borderRadius: 2, backgroundColor: phoneFrame.statusInk },
  battery: { width: 16, height: 7, borderRadius: 2, backgroundColor: phoneFrame.statusInk },
});
