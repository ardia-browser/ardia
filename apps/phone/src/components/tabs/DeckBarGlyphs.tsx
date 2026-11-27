import { StyleSheet, Text, View } from "react-native";
import { IncognitoEyes } from "../ui/IncognitoEyes";
import { BarPlusGlyph, deckChromeLayout, font, iPhoneOr, SystemGlyph, useSurfaceInk } from "../ui";

export function IncognitoGlyph({ incognito }: { incognito: boolean }) {
  return <IncognitoEyes incognito={incognito} size={deckChromeLayout.incognitoEyes} color={useSurfaceInk().roles.label} />;
}

export function SearchTabsGlyphs() {
  const { roles } = useSurfaceInk();
  return (
    <View style={styles.search}>
      <SystemGlyph systemName="magnifyingglass" pointSize={14} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.secondaryLabel} />
      <Text numberOfLines={1} style={[font.callout, styles.words, { color: iPhoneOr(roles.tertiaryLabel, roles.secondaryLabel) }]}>
        Search Tabs
      </Text>
    </View>
  );
}

export function SearchTabsGlyph() {
  return <SystemGlyph systemName="magnifyingglass" pointSize={18} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={useSurfaceInk().roles.label} />;
}

export function PlusGlyph() {
  return <BarPlusGlyph color={useSurfaceInk().roles.label} />;
}

const styles = StyleSheet.create({
  search: { flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: deckChromeLayout.searchSpacing, paddingLeft: deckChromeLayout.searchLead, paddingRight: deckChromeLayout.searchTrail },
  words: { flex: 1 },
});
