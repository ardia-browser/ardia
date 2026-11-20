import { Image, StyleSheet, useWindowDimensions, View } from "react-native";
import { withAlpha } from "../../lib/color";
import { useTheme } from "./theme";
import { appIconLayout } from "./tokens";

const APP_ICON_IMAGE = require("../../../assets/appIconPreview.png") as number;

type Props = { side: number; shadow?: boolean; scalesWithText?: boolean };

export function AppIcon({ side, shadow = false, scalesWithText = true }: Props) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const scaled = scalesWithText ? side * Math.min(fontScale, appIconLayout.maxScale) : side;
  const corner = scaled * appIconLayout.corner;
  return (
    <View
      testID="appIcon"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: scaled, height: scaled, borderRadius: corner, backgroundColor: appIconLayout.fill }, shadow ? styles.shadow : null]}
    >
      <Image source={APP_ICON_IMAGE} resizeMode="cover" style={{ width: scaled, height: scaled, borderRadius: corner }} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: corner, borderWidth: appIconLayout.edge, borderColor: withAlpha(theme.label, appIconLayout.edgeAlpha) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { boxShadow: appIconLayout.shadow },
});
