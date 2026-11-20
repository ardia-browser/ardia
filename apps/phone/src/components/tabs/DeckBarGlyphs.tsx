import { StyleSheet, Text, View } from "react-native";
import { capsule, deckChromeLayout, font, ink, iPhoneOr, rolesFor, startLayout, Symbol, SystemGlyph, tabsInk, useTheme } from "../ui";

export function IncognitoGlyph({ incognito, dark }: { incognito: boolean; dark: boolean }) {
  const theme = useTheme();
  if (!incognito) return <Symbol name="eyes" size={deckChromeLayout.incognitoEyes} color={rolesFor(dark).label} />;
  return (
    <View style={styles.switch}>
      <View style={[styles.switchOn, { backgroundColor: theme.dark ? ink.white : tabsInk.incognitoCard }]} />
      <Symbol name="eyesClosed" size={deckChromeLayout.incognitoEyes} color={theme.dark ? tabsInk.incognitoCard : ink.white} />
    </View>
  );
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
  return <SystemGlyph systemName="plus" pointSize={18} weight="medium" name="plus" size={startLayout.plusGlyph} color={rolesFor(dark).label} />;
}

const styles = StyleSheet.create({
  switch: { width: deckChromeLayout.barCircle, height: deckChromeLayout.barCircle, alignItems: "center", justifyContent: "center" },
  switchOn: { position: "absolute", width: deckChromeLayout.barCircle, height: deckChromeLayout.barCircle, borderRadius: capsule(deckChromeLayout.barCircle) },
  search: { flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: deckChromeLayout.searchSpacing, paddingLeft: deckChromeLayout.searchLead, paddingRight: deckChromeLayout.searchTrail },
  words: { flex: 1 },
});
