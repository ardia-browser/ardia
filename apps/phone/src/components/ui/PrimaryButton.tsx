import { Platform, Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "./theme";
import { font, settingsLayout, smoothCorners } from "./tokens";

export const primaryButtonHeight = (os: string = Platform.OS) => (os === "ios" ? settingsLayout.primaryButton.height.ios : settingsLayout.primaryButton.height.android);

export function PrimaryButton({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, { minHeight: primaryButtonHeight(), backgroundColor: theme.spaceAccent, opacity: pressed ? 0.82 : 1 }]}
    >
      <Text style={[font.body, styles.label, { color: theme.onSpaceAccent }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: settingsLayout.primaryButton.radius, ...smoothCorners, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingVertical: 12 },
  label: { fontWeight: "600", textAlign: "center" },
});
