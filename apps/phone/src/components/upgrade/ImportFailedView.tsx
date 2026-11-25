import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../lib/platformCopy";
import { retryImport, startWithoutImporting, useBoot } from "../../state/app/boot";
import { importChoices } from "../../state/legacy/importRules";
import { offersStartWithout } from "../../state/legacy/upgrade";
import { ActionButton, failureLayout, font, space, Symbol, useTheme } from "../ui";

export function ImportFailedView() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const failures = useBoot((s) => s.failures);
  const busy = useBoot((s) => s.busy);
  const words = copy().importFailed;
  const choices = importChoices(failures, offersStartWithout());
  return (
    <View testID="importFailed" style={[StyleSheet.absoluteFill, styles.column, { backgroundColor: theme.appSurface, paddingTop: insets.top, paddingBottom: insets.bottom + space.l }]}>
      <View style={styles.icon}>
        <Symbol name="exclamationmarkTriangle" size={failureLayout.icon} color={theme.secondaryLabel} />
      </View>
      <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.text, { color: theme.label }]}>
        {words.title}
      </Text>
      <Text style={[font.subheadline, styles.text, { color: theme.secondaryLabel }]}>{words.body}</Text>
      <View style={styles.retry}>
        <ActionButton testID="importRetry" title={words.tryAgain} variant="outlined" tone="accent" busy={busy} onPress={retryImport} />
      </View>
      {choices.startWithout ? (
        <View style={styles.without}>
          <ActionButton testID="importStartWithout" title={words.startWithout} variant="plain" tone="accent" size="compact" disabled={busy} onPress={() => void startWithoutImporting()} />
          <Text style={[font.footnote, styles.text, { color: theme.secondaryLabel }]}>{words.startWithoutNote}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignItems: "center", justifyContent: "center", gap: space.s, paddingHorizontal: space.huge },
  icon: { paddingBottom: space.xs },
  bold: { fontWeight: "600" },
  text: { textAlign: "center", maxWidth: failureLayout.textWidth },
  retry: { marginTop: space.m },
  without: { marginTop: space.s, alignItems: "center", gap: space.xs },
});
