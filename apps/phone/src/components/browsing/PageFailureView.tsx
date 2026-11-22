import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { actionWords } from "../../lib/sharedWords";
import { useNavigation } from "../../state/browse/hooks";
import { retryPage, retryWhenOnline } from "../../state/page/actions";
import { failureIcon, holdFailure, NO_FAILURE, retriesWhenOnline, type FailureIcon } from "../../state/page/pageFailure";
import { ActionButton, failureLayout, font, space, Symbol, useTheme, type SymbolName } from "../ui";
import { failureRetry } from "./pageStateTokens";

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
    <View testID="pageFailure" style={[StyleSheet.absoluteFill, styles.column, { backgroundColor: theme.appSurface }]}>
      <View testID="pageFailureIcon" style={styles.icon}>
        <Symbol name={ICONS[failureIcon(failure)]} size={failureRetry.iconBox} color={theme.secondaryLabel} />
      </View>
      <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.text, { color: theme.label }]}>
        {failure.title}
      </Text>
      <Text style={[font.subheadline, styles.text, { color: theme.secondaryLabel }]}>{failure.message}</Text>
      <View style={styles.retry}>
        <ActionButton testID="pageFailureRetry" title={actionWords.tryAgain} variant={failureRetry.variant} tone="neutral" size={failureRetry.size} capsule busy={isLoading} onPress={() => retryPage(tabId)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignItems: "center", justifyContent: "center", gap: space.s, paddingHorizontal: space.huge },
  icon: { width: failureLayout.icon, height: failureLayout.icon, alignItems: "center", justifyContent: "center", overflow: "visible", marginBottom: space.xs },
  bold: { fontWeight: "600" },
  text: { textAlign: "center", maxWidth: failureLayout.textWidth },
  retry: { marginTop: space.m },
});
