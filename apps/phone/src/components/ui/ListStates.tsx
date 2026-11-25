import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { listWords } from "../../lib/sharedWords";
import { ActionButton } from "./ActionButton";
import { announceForScreenReader } from "./coverFocus";
import { iconRoles } from "./iconRoles";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme } from "./theme";
import { emptyStateLayout, font } from "./tokens";

type EmptyStateProps = {
  title: string;
  glyph?: SymbolName;
  message?: string;
  action?: { title: string; onPress: () => void };
  testID?: string;
  ink?: StateInk;
};

export function EmptyState({ title, glyph, message, action, testID, ink }: EmptyStateProps) {
  const theme = useTheme();
  const label = ink?.label ?? theme.label;
  const secondary = ink?.secondary ?? theme.secondaryLabel;
  return (
    <View testID={testID} style={styles.column}>
      {glyph ? (
        <View style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Symbol name={glyph} size={emptyStateLayout.glyph} color={secondary} />
        </View>
      ) : null}
      <Text accessibilityRole="header" style={[font.title3, styles.title, { color: label }]}>
        {title}
      </Text>
      {message ? <Text style={[font.subheadline, styles.message, { color: secondary }]}>{message}</Text> : null}
      {action ? (
        <View style={styles.action}>
          <ActionButton title={action.title} onPress={action.onPress} variant="plain" tone="accent" size="compact" />
        </View>
      ) : null}
    </View>
  );
}

export function NoResultsState({ query, onClear, clearTitle, testID }: { query: string; onClear?: () => void; clearTitle?: string; testID?: string }) {
  return <EmptyState testID={testID} title={listWords.noResults} glyph={iconRoles.noResults} message={listWords.noResultsCue(query)} action={onClear && clearTitle ? { title: clearTitle, onPress: onClear } : undefined} />;
}

export type LoadingContract = { label: string; role: "progressbar"; busy: true; liveRegion: "polite"; nativeTraits: ["updatesFrequently"] };

export const loadingContract = (label: string = listWords.loading): LoadingContract => ({ label, role: "progressbar", busy: true, liveRegion: "polite", nativeTraits: ["updatesFrequently"] });

export function useLoadingAnnouncement(label: string) {
  useEffect(() => {
    let live = true;
    announceForScreenReader(label, () => live);
    return () => {
      live = false;
    };
  }, [label]);
}

type StateInk = { label: string; secondary: string };

export function LoadingState({ label, testID, ink }: { label?: string; testID?: string; ink?: StateInk }) {
  const theme = useTheme();
  const contract = loadingContract(label);
  const secondary = ink?.secondary ?? theme.secondaryLabel;
  useLoadingAnnouncement(contract.label);
  return (
    <View testID={testID} style={styles.column} accessible accessibilityRole={contract.role} accessibilityLabel={contract.label} accessibilityState={{ busy: contract.busy }} accessibilityLiveRegion={contract.liveRegion}>
      <ActivityIndicator color={secondary} />
      <Text style={[font.subheadline, styles.message, { color: secondary }]}>{contract.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignSelf: "center", alignItems: "center", maxWidth: emptyStateLayout.maxWidth, padding: emptyStateLayout.pad, gap: emptyStateLayout.gap },
  glyph: { marginBottom: emptyStateLayout.glyphGap - emptyStateLayout.gap },
  title: { fontWeight: "600", textAlign: "center" },
  message: { textAlign: "center" },
  action: { marginTop: emptyStateLayout.actionGap - emptyStateLayout.gap },
});
