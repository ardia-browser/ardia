import { StyleSheet, Text, View } from "react-native";
import { tileGradient } from "../../lib/favicon";
import { linearGradientCss } from "../../lib/gradient";
import { AppIcon, font, onboardingArt, PROFILE_COLORS, shadowCss, smoothCorners, space, Symbol, useTheme } from "../ui";

export function LinkBubble() {
  const theme = useTheme();
  return (
    <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.card, { backgroundColor: theme.groupFill, boxShadow: shadowCss("card", theme.dark) }]}>
        <View style={[styles.strip, { experimental_backgroundImage: linearGradientCss(tileGradient(PROFILE_COLORS.plum.swatch), false, 1, 1) }]} />
        <View style={styles.words}>
          <Text style={[font.subheadline, styles.bold, { color: theme.label }]} numberOfLines={1}>
            The best tapas in Lisbon
          </Text>
          <Text style={[font.caption, { color: theme.secondaryLabel }]}>timeout.com</Text>
        </View>
      </View>
      <View style={styles.arrow}>
        <Symbol name="arrowRight" size={onboardingArt.arrowGlyph} color={theme.spaceAccentInk} />
      </View>
      <View testID="linkBubbleIcon" style={styles.icon}>
        <AppIcon side={onboardingArt.appIcon} shadow scalesWithText={false} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: space.m },
  card: {
    width: onboardingArt.linkCardWidth,
    borderRadius: onboardingArt.linkCardRadius,
    ...smoothCorners,
    overflow: "hidden",
  },
  strip: { minHeight: onboardingArt.stripHeight },
  words: { paddingHorizontal: space.m, paddingVertical: onboardingArt.wordsVertical, gap: space.tight },
  bold: { fontWeight: "700" },
  arrow: { paddingBottom: onboardingArt.arrowLift },
  icon: { marginBottom: space.s },
});
