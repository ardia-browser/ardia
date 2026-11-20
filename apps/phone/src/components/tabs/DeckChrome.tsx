import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { capsule, font, IncognitoSpecs, space, tabsInk, tabsLayout, useTheme } from "../ui";

export function deckEmptyWords(searching: boolean, incognito: boolean): { title: string; detail: string | null } {
  if (searching) return { title: "No Matching Tabs", detail: null };
  if (incognito) return { title: "No Incognito Tabs", detail: "Incognito tabs aren’t saved to your history or the Archive." };
  return { title: "No Open Tabs", detail: "Tabs you open appear here. Inactive tabs move to the Archive." };
}

export function DeckEmpty({ centerY, showsArchive, onArchive, searching = false, incognito = false }: { centerY: number; showsArchive: boolean; onArchive: () => void; searching?: boolean; incognito?: boolean }) {
  const words = deckEmptyWords(searching, incognito);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.empty, { top: centerY - space.huge * 2, left: (width - tabsLayout.emptyWidth) / 2, width: tabsLayout.emptyWidth }]}>
      <Text style={[font.title3, styles.emptyTitle, { color: theme.headerText }]}>{words.title}</Text>
      {words.detail ? <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>{words.detail}</Text> : null}
      {showsArchive && !searching && !incognito ? (
        <Pressable accessibilityRole="button" onPress={onArchive} style={styles.archive}>
          <Text style={[font.subheadline, styles.bold, { color: theme.formAccent }]}>Open Archive</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function IncognitoChip({ count, top, onPress }: { count: number; top: number; onPress: () => void }) {
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.chipRow, { top, width }]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Incognito, ${count} ${count === 1 ? "tab" : "tabs"}`}
        accessibilityHint="Shows the option to close incognito tabs."
        onPress={onPress}
        style={[styles.chip, { backgroundColor: tabsInk.incognitoCard, borderRadius: capsule(tabsLayout.chipHeight) }]}
      >
        <IncognitoSpecs size={tabsLayout.specsChip} color={tabsInk.onDark} />
        <Text style={[font.subheadline, styles.bold, styles.chipText]}>Incognito</Text>
        <Text style={[font.subheadline, styles.bold, { color: tabsInk.onDarkChip }]}>{count}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { position: "absolute", alignItems: "center", gap: space.xs + 2 },
  emptyTitle: { fontWeight: "600", textAlign: "center" },
  centered: { textAlign: "center" },
  bold: { fontWeight: "600" },
  archive: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.m, marginTop: space.xs + 2 },
  chipRow: { position: "absolute", left: 0, height: 44, alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: tabsLayout.chipHeight, paddingHorizontal: space.m },
  chipText: { color: tabsInk.onDark },
});
