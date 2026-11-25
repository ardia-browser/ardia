import { StyleSheet, View } from "react-native";
import { useTheme, WindowBackdrop } from "../ui";
import { profileTheme } from "../ui/theme";
import { useAppDark, useSettings } from "../../state/browser/hooks";
import { spaceLookSource } from "../../lib/profileLook";
import { useLiveTheme } from "./liveTheme";

export function ThemeGradient() {
  const scoped = useTheme();
  const live = useLiveTheme();
  const appDark = useAppDark();
  const source = useSettings(spaceLookSource);
  const theme = live ? profileTheme({ color: scoped.profileColor === "incognito" ? "plum" : scoped.profileColor, theme: live.theme }, appDark, source) : scoped;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
    </View>
  );
}
