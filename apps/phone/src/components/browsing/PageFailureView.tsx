import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "../../state/browse/hooks";
import { retryPage, retryWhenOnline } from "../../state/page/actions";
import { failureIcon, holdFailure, NO_FAILURE, retriesWhenOnline, type FailureIcon } from "../../state/page/pageFailure";
import { capsule, failureLayout, font, space, Symbol, useTheme, type SymbolName } from "../ui";
import { failureButton } from "./pageStateTokens";

const ICONS: Record<FailureIcon, SymbolName> = { crashed: "exclamationmarkTriangle", offline: "wifiSlash", network: "globe" };

export function PageFailureView({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const live = useNavigation(tabId, (n) => n?.failure ?? null);
  const isLoading = useNavigation(tabId, (n) => n?.isLoading ?? false);
  const hold = useRef(NO_FAILURE);
  hold.current = holdFailure(hold.current, live, isLoading);
  const failure = hold.current.shown;
  const waitsForNetwork = live ? retriesWhenOnline(live) : false;
  useEffect(() => (waitsForNetwork ? retryWhenOnline(tabId) : undefined), [waitsForNetwork, tabId]);
  if (!failure) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.column, { backgroundColor: theme.surface }]}>
      <View testID="pageFailureIcon" style={styles.icon}>
        <Symbol name={ICONS[failureIcon(failure)]} size={failureButton.iconBox} color={theme.secondaryLabel} />
      </View>
      <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.text, { color: theme.label }]}>
        {failure.title}
      </Text>
      <Text style={[font.subheadline, styles.text, { color: theme.secondaryLabel }]}>{failure.message}</Text>
      <Pressable
        testID="pageFailureRetry"
        accessibilityRole="button"
        onPress={() => retryPage(tabId)}
        style={[styles.retry, failureButton.filled ? { backgroundColor: theme.dark ? failureButton.fill.dark : failureButton.fill.light } : { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.separator }]}
      >
        <Text style={[font.body, { color: theme.spaceAccentInk }]}>Try Again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignItems: "center", justifyContent: "center", gap: space.s, paddingHorizontal: space.huge },
  icon: { width: failureLayout.icon, height: failureLayout.icon, alignItems: "center", justifyContent: "center", overflow: "visible", marginBottom: space.xs },
  bold: { fontWeight: "600" },
  text: { textAlign: "center", maxWidth: failureLayout.textWidth },
  retry: {
    marginTop: space.m,
    minHeight: failureButton.height,
    paddingHorizontal: failureButton.sideInset,
    borderRadius: capsule(failureButton.height),
    justifyContent: "center",
  },
});
