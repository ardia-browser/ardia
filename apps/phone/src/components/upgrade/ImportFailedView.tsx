import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../lib/platformCopy";
import { retryImport, startWithoutImporting, useBoot } from "../../state/app/boot";
import { importChoices } from "../../state/legacy/importRules";
import { offersStartWithout } from "../../state/legacy/upgrade";
import { controlRadius, failureLayout, font, space, Symbol, useTheme } from "../ui";

export function ImportFailedView() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const failures = useBoot((s) => s.failures);
  const busy = useBoot((s) => s.busy);
  const words = copy().importFailed;
  const choices = importChoices(failures, offersStartWithout());
  return (
    <View style={[StyleSheet.absoluteFill, styles.column, { backgroundColor: theme.surface, paddingTop: insets.top, paddingBottom: insets.bottom + space.l }]}>
      <View style={styles.icon}>
        <Symbol name="exclamationmarkTriangle" size={failureLayout.icon} color={theme.secondaryLabel} />
      </View>
      <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.text, { color: theme.label }]}>
        {words.title}
      </Text>
      <Text style={[font.subheadline, styles.text, { color: theme.secondaryLabel }]}>{words.body}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={busy ? words.tryingAgain : words.tryAgain}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={retryImport}
        style={[styles.retry, { borderColor: theme.separator }]}
      >
        {busy ? <ActivityIndicator color={theme.secondaryLabel} /> : <Text style={[font.body, { color: theme.spaceAccentInk }]}>{words.tryAgain}</Text>}
      </Pressable>
      {choices.startWithout ? (
        <View style={styles.without}>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void startWithoutImporting()} style={styles.plain}>
            <Text style={[font.body, { color: busy ? theme.secondaryLabel : theme.spaceAccentInk }]}>{words.startWithout}</Text>
          </Pressable>
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
  retry: {
    marginTop: space.m,
    minHeight: failureLayout.button,
    minWidth: failureLayout.button * 3,
    paddingHorizontal: space.xxl,
    borderRadius: controlRadius(failureLayout.button),
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  without: { marginTop: space.s, alignItems: "center", gap: space.xs },
  plain: { minHeight: 44, paddingHorizontal: space.l, justifyContent: "center" },
});
