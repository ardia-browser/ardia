import { useEffect } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { askForDefaultBrowser, refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { popSettings } from "../../state/settings/nav";
import { defaultBrowserCopy } from "../../state/settings/settingsRules";
import { AppIcon, font, ink, PrimaryButton, radius, settingsLayout, settingsTint, space, spacesLayout, Symbol, useTheme } from "../ui";
import { SettingsPage } from "./SettingsKit";

export function DefaultBrowserSteps({ onLater, onDone }: { onLater?: () => void; onDone?: () => void }) {
  const theme = useTheme();
  const status = useDefaultBrowser((s) => s.status);
  const { fontScale } = useWindowDimensions();
  useEffect(() => {
    void refreshDefaultBrowser();
    const returns = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshDefaultBrowser();
    });
    return () => returns.remove();
  }, []);
  if (!status) return null;
  const copy = defaultBrowserCopy(status);
  const listsSteps = fontScale >= settingsLayout.accessibilityFontScale;
  const ask = async () => {
    if (copy.inSettings) onDone?.();
    const after = await askForDefaultBrowser(copy.does);
    if (copy.inSettings) return;
    if (after.unavailable) onLater?.();
    else if (after.status?.isDefault) onDone?.();
  };
  return (
    <View style={styles.column}>
      <View style={styles.words}>
        <Text accessibilityRole="header" style={[font.title, styles.heavy, { color: theme.label }]}>
          {copy.title}
        </Text>
        <Text style={[font.body, styles.centered, { color: theme.secondaryLabel }]}>{copy.subtitle}</Text>
      </View>
      {copy.steps.length && listsSteps ? (
        <View testID="defaultBrowserList" style={styles.list}>
          {copy.steps.map((step, index) => (
            <Text key={step} style={[font.body, { color: theme.label }]}>{`${index + 1}. ${step}`}</Text>
          ))}
        </View>
      ) : copy.steps.length ? (
        <View style={[styles.card, { backgroundColor: theme.groupFill }]}>
          {copy.steps.map((step, index) => (
            <View key={step}>
              <View accessible style={styles.step}>
                <StepIcon index={index} count={copy.steps.length} inSettings={copy.inSettings} />
                <Text style={[font.body, styles.fill, { color: theme.label }]}>{`${index + 1}. ${step}`}</Text>
              </View>
              {index < copy.steps.length - 1 ? <View style={[styles.divider, { backgroundColor: theme.separator }]} /> : null}
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        {copy.action ? (
          <PrimaryButton title={copy.action} onPress={() => void ask()} />
        ) : onLater ? (
          <PrimaryButton title="Continue" onPress={onLater} />
        ) : null}
        {copy.action && onLater ? (
          <Pressable accessibilityRole="button" onPress={onLater} style={styles.secondary}>
            <Text style={[font.body, styles.bold, { color: theme.label }]}>Maybe Later</Text>
          </Pressable>
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
  bold: { fontWeight: "600" },
  fill: { flex: 1 },
  card: { borderRadius: radius.card, overflow: "hidden" },
  step: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: 52, paddingHorizontal: space.l },
  tile: { width: settingsLayout.tile, height: settingsLayout.tile, borderRadius: spacesLayout.stepTileRadius, alignItems: "center", justifyContent: "center" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: spacesLayout.stepDividerInset },
  actions: { gap: space.s },
  secondary: { minHeight: 44, alignItems: "center", justifyContent: "center" },
});
