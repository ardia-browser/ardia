import { StyleSheet, Text, View } from "react-native";
import { IncognitoEyes } from "../ui/IncognitoEyes";
import { BarPlusGlyph, deckChromeLayout, font, iPhoneOr, rolesFor, SystemGlyph } from "../ui";

export function IncognitoGlyph({ incognito, dark }: { incognito: boolean; dark: boolean }) {
  return <IncognitoEyes incognito={incognito} size={deckChromeLayout.incognitoEyes} color={rolesFor(dark).label} />;
}

export function SearchTabsGlyphs({ dark }: { dark: boolean }) {
  const roles = rolesFor(dark);
  return (
    <View style={styles.search}>
      <SystemGlyph systemName="magnifyingglass" pointSize={14} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={roles.secondaryLabel} />
      <Text numberOfLines={1} style={[font.callout, styles.words, { color: iPhoneOr(roles.tertiaryLabel, roles.secondaryLabel) }]}>
        Search Tabs
      </Text>
    </View>
  );
}

export function SearchTabsGlyph({ dark }: { dark: boolean }) {
  return <SystemGlyph systemName="magnifyingglass" pointSize={18} weight="medium" fitted name="magnifyingglass" size={deckChromeLayout.searchGlyph} color={rolesFor(dark).label} />;
}

export function PlusGlyph({ dark }: { dark: boolean }) {
  return <BarPlusGlyph color={rolesFor(dark).label} />;
}

const styles = StyleSheet.create({
  search: { flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: deckChromeLayout.searchSpacing, paddingLeft: deckChromeLayout.searchLead, paddingRight: deckChromeLayout.searchTrail },
  words: { flex: 1 },
});
