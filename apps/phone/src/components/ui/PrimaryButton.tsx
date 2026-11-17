import { Platform, Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "./theme";
import { font, settingsLayout } from "./tokens";

export const primaryButtonHeight = (os: string = Platform.OS) => (os === "ios" ? settingsLayout.primaryButton.height.ios : settingsLayout.primaryButton.height.android);

export function PrimaryButton({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.button, { minHeight: primaryButtonHeight(), backgroundColor: theme.primaryAction }]}
    >
      <Text style={[font.body, styles.label, { color: theme.onPrimaryAction }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: settingsLayout.primaryButton.radius, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingVertical: 12 },
  label: { fontWeight: "600", textAlign: "center" },
});
