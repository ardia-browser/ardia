import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { startLayout, useDesign, useTheme } from "../ui";
import { useMaterialTheme } from "../ui/materialTheme";
import { useUpdateDot } from "../../state/appUpdate/store";

export const UPDATE_DOT_WORDS = "update available";

export const withUpdateWords = (label: string, shown: boolean) => (shown ? `${label}, ${UPDATE_DOT_WORDS}` : label);

export function NoticeDot({ style }: { style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const { scheme } = useMaterialTheme();
  const fill = useDesign() === "material" ? scheme.primary : theme.spaceAccentInk;
  return <View testID="updateDot" pointerEvents="none" style={[styles.dot, { backgroundColor: fill }, style]} />;
}

export function UpdateDot({ style }: { style?: StyleProp<ViewStyle> }) {
  return useUpdateDot() ? <NoticeDot style={style} /> : null;
}

const GLYPH_CORNER = 10;

export const dotBesideGlyph = (side: number): ViewStyle => {
  const inset = Math.max(0, side / 2 - GLYPH_CORNER - startLayout.pageDot / 2);
  return { position: "absolute", top: inset, right: inset };
};

const styles = StyleSheet.create({
  dot: { width: startLayout.pageDot, height: startLayout.pageDot, borderRadius: startLayout.pageDot / 2 },
});
