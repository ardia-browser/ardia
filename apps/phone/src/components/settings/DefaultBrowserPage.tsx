import { useEffect } from "react";
import { AppState, Platform, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { askForDefaultBrowser, refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { popSettings } from "../../state/settings/nav";
import { defaultBrowserCopy } from "../../state/settings/settingsRules";
import { ActionButton, AppIcon, font, ink, PrimaryButton, radius, settingsLayout, settingsTint, space, spacesLayout, Symbol, useTheme, smoothCorners } from "../ui";
import { SettingsPage } from "./SettingsKit";

export function useDefaultBrowserFlow({ onLater, onDone }: { onLater?: () => void; onDone?: () => void }) {
  const status = useDefaultBrowser((s) => s.status);
  useEffect(() => {
    void refreshDefaultBrowser();
    const returns = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshDefaultBrowser();
    });
    return () => returns.remove();
  }, []);
  const copy = status ? defaultBrowserCopy(status) : null;
  const ask = async () => {
    if (!copy) return;
    if (copy.inSettings) onDone?.();
    const after = await askForDefaultBrowser(copy.does);
    if (copy.inSettings) return;
    if (after.unavailable) onLater?.();
    else if (after.status?.isDefault) onDone?.();
  };
  return { copy, ask };
}

export function DefaultBrowserSteps({ onLater, onDone, headingRef, inkActions = false }: { onLater?: () => void; onDone?: () => void; headingRef?: (node: ViewInstance | null) => void; inkActions?: boolean }) {
  const theme = useTheme();
  const titleInk = theme.label;
  const bodyInk = theme.secondaryLabel;
  const { fontScale } = useWindowDimensions();
  const { copy, ask } = useDefaultBrowserFlow({ onLater, onDone });
  if (!copy) return null;
  const listsSteps = fontScale >= settingsLayout.accessibilityFontScale;
  return (
    <View style={styles.column}>
      <View style={styles.words}>
        <Text ref={headingRef} accessibilityRole="header" style={[font.title, styles.heavy, { color: titleInk }]}>
          {copy.title}
        </Text>
        <Text style={[font.body, styles.centered, { color: bodyInk }]}>{copy.subtitle}</Text>
      </View>
      {copy.steps.length && listsSteps ? (
        <View testID="defaultBrowserList" style={styles.list}>
          {copy.steps.map((step, index) => (
            <Text key={step} style={[font.body, { color: titleInk }]}>{`${index + 1}. ${step}`}</Text>
          ))}
        </View>
      ) : copy.steps.length ? (
        <View style={[styles.card, { backgroundColor: theme.groupFill }]}>
          {copy.steps.map((step, index) => (
            <View key={step}>
              <View accessible style={styles.step}>
                <StepIcon index={index} count={copy.steps.length} inSettings={copy.inSettings} />
                <Text style={[font.body, styles.fill, { color: titleInk }]}>{`${index + 1}. ${step}`}</Text>
              </View>
              {index < copy.steps.length - 1 ? <View style={[styles.divider, { backgroundColor: theme.separator }]} /> : null}
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        {copy.action ? (
          inkActions ? <ActionButton title={copy.action} onPress={() => void ask()} variant="filled" tone="ink" size="hero" capsule /> : <PrimaryButton title={copy.action} onPress={() => void ask()} />
        ) : onLater ? (
          inkActions ? <ActionButton title="Continue" onPress={onLater} variant="filled" tone="ink" size="hero" capsule /> : <PrimaryButton title="Continue" onPress={onLater} />
        ) : null}
        {copy.action && onLater ? (
          <ActionButton title="Maybe Later" onPress={onLater} variant="plain" tone={inkActions ? "ink" : "neutral"} size="regular" />
        ) : null}
      </View>
    </View>
  );
}

function StepIcon({ index, count, inSettings }: { index: number; count: number; inSettings: boolean }) {
  const theme = useTheme();
  if (index === count - 1) return <AppIcon side={settingsLayout.tile} />;
  if (inSettings && index === 0) {
    return (
      <View style={[styles.tile, { backgroundColor: settingsTint.neutral }]}>
        <Symbol name="gearshape" size={17} color={ink.white} />
      </View>
    );
  }
  if (inSettings) {
    return (
      <View style={styles.tile}>
        <Symbol name="handPointUpLeftFill" size={18} color={theme.secondaryLabel} />
      </View>
    );
  }
  return (
    <View style={[styles.tile, { backgroundColor: settingsTint.defaultBrowser }]}>
      <Symbol name="handPointUpLeftFill" size={18} color={ink.white} />
    </View>
  );
}

export function DefaultBrowserPage() {
  return (
    <SettingsPage title="Default Browser" onBack={popSettings}>
      <DefaultBrowserSteps />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  column: { gap: space.xxl, paddingHorizontal: space.l + 4, paddingTop: space.l },
  words: { gap: space.s, alignItems: "center" },
  heavy: { fontWeight: "700", textAlign: "center", ...(Platform.OS === "ios" ? { fontFamily: "ui-rounded" } : null) },
  list: { gap: space.m },
  centered: { textAlign: "center" },
  fill: { flex: 1 },
  card: { borderRadius: radius.card, ...smoothCorners, overflow: "hidden" },
  step: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: 52, paddingHorizontal: space.l },
  tile: { width: settingsLayout.tile, height: settingsLayout.tile, borderRadius: spacesLayout.stepTileRadius, ...smoothCorners, alignItems: "center", justifyContent: "center" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: spacesLayout.stepDividerInset },
  actions: { gap: space.s },
});
