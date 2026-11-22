import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig } from "react-native-reanimated";
import { refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { offersDefaultBrowser } from "../../state/settings/settingsRules";
import { markSheetFromSettings, openArchive, openSpaces } from "../../state/browse/store";
import { useSyncEnabled, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName, syncRowSubtitle } from "../../state/sync/syncRules";
import { showOnboardingFromSettings } from "../../state/onboarding/store";
import { appVersion, exportOpenTabs, setAppLinks, setArchiveInterval, setAutoOpenKeyboard, setDynamicColors, setMaterialYou, setSearchSuggestions, useEngines } from "../../state/settings/actions";
import { wallpaperColorsEnabled } from "../../lib/material/schemePick";
import { usePreferences } from "../../state/settings/hooks";
import { closeSettings, pushSettings } from "../../state/settings/nav";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { controlRadius, duration, font, materialYouOffered, settingsLayout, settingsTint, space, Symbol, useDesign, useTheme, useWarningInk, Tappable } from "../ui";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { setUsageSharing, useUsageSharing } from "../../state/telemetry/telemetry";
import { AppearanceRow, ColorRow, MatchMyMac } from "./AppearancePage";
import { focusForScreenReader } from "../ui/coverFocus";
import { BarButton, Group, IconTile, NavRow, PickerRow, SettingsPage, ToggleRow } from "./SettingsKit";
import { syncOffered } from "../../state/sync/offer";
import { browseForMeOffered, refreshChatGPTConnected, useChatGPTConnected } from "../../state/browseForMe/store";
import { browseForMeRowValue } from "../../state/browseForMe/copy";
import { pageSummaryChoiceOffered, refreshPageSummaryProvider, usePageSummaryProvider } from "../../state/pageSummary/store";
import { pageSummaryRowValue } from "../../state/pageSummary/copy";
import { refreshPageSummariesEnabled, usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { destinationWords, dismissWords } from "../../lib/sharedWords";

const APP_LINKS = [
  { id: "ardia" as const, title: "Ardia" },
  { id: "app" as const, title: "App" },
];

const INTERVALS = (Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[]).map((id) => ({ id, title: autoArchiveTitle(id) }));

export function SettingsRoot() {
  const theme = useTheme();
  const engineId = usePreferences((p) => p.searchEngineId);
  const suggestions = usePreferences((p) => p.searchSuggestions);
  const keyboard = usePreferences((p) => p.autoOpensKeyboard);
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const engines = useEngines((s) => s.engines);
  const appLinks = useEngines((s) => s.appLinks);
  const sharing = useUsageSharing((s) => s.sharing);
  const syncEnabled = useSyncEnabled();
  const offersDefault = offersDefaultBrowser(useDefaultBrowser((s) => s.status));
  useEffect(() => {
    void refreshDefaultBrowser();
  }, []);
  const synced = useSyncView().search;
  const engineName = syncEnabled && synced ? syncedEngineName(synced, engines) : (engines.find((engine) => engine.id === engineId)?.name ?? "");
  const stacks = useWindowDimensions().fontScale >= settingsLayout.accessibilityFontScale;
  const design = useDesign();
  const redesigned = design === "redesigned";
  const material = design === "material";
  const materialSwitch = useRef<ViewInstance>(null);
  const restoreSwitchFocus = useRef(false);
  useEffect(() => {
    if (!restoreSwitchFocus.current) return;
    restoreSwitchFocus.current = false;
    return focusForScreenReader(() => materialSwitch.current);
  }, [material]);
  const changeMaterialYou = (value: boolean) => {
    restoreSwitchFocus.current = true;
    setMaterialYou(value);
  };
  const dynamicColors = wallpaperColorsEnabled(usePreferences((p) => p.colorChoice), usePreferences((p) => p.dynamicColors));
  const chatGPT = useChatGPTConnected();
  const summaryProvider = usePageSummaryProvider();
  const summaries = usePageSummariesEnabled();
  const offersBrowseForMe = browseForMeOffered();
  const offersSummaryChoice = pageSummaryChoiceOffered();
  useEffect(() => {
    void refreshChatGPTConnected();
    void refreshPageSummaryProvider();
    void refreshPageSummariesEnabled();
  }, []);
  return (
    <SettingsPage title={destinationWords.settings} onClose={material ? closeSettings : undefined} trailing={material ? undefined : <BarButton title={dismissWords.done} emphasized onPress={closeSettings} />}>
      {syncOffered() ? (
        <Group>
          <SyncCard stacks={stacks} />
        </Group>
      ) : null}
      <View testID="settingsShortcuts" style={[styles.shortcuts, { flexDirection: stacks ? "column" : "row" }]}>
        <Tappable
          kind="filled"
          label={destinationWords.archive}
          onPress={() => {
            closeSettings();
            openArchive();
            markSheetFromSettings();
          }}
          style={[styles.shortcut, stacks ? null : styles.fill, { backgroundColor: theme.groupFill }]}
        >
          <Symbol name="archivebox" size={20} color={theme.label} />
          <Text style={[font.body, styles.medium, { color: theme.label }]}>{destinationWords.archive}</Text>
        </Tappable>
        {syncOffered() ? (
          <Tappable
            kind="filled"
            label={destinationWords.spaces}
            onPress={() => {
              closeSettings();
              openSpaces();
              markSheetFromSettings();
            }}
            style={[styles.shortcut, stacks ? null : styles.fill, { backgroundColor: theme.groupFill }]}
          >
            <Symbol name="squareStack" size={20} color={theme.label} />
            <Text style={[font.body, styles.medium, { color: theme.label }]}>{destinationWords.spaces}</Text>
          </Tappable>
        ) : null}
      </View>
      <Group header="General">
        {redesigned ? (
          <AppearanceRow />
        ) : material ? (
          <>
            <ToggleRow title="Dynamic Colors" icon="paintpaletteFill" tint={settingsTint.neutral} value={dynamicColors} divider onChange={setDynamicColors} />
            {!dynamicColors ? <ColorRow plainIcon /> : null}
          </>
        ) : (
          <>
            <ColorRow />
            {syncEnabled ? <MatchMyMac /> : null}
          </>
        )}
        {material ? null : <View style={[styles.divider, { backgroundColor: theme.separator }]} />}
        {materialYouOffered() ? <ToggleRow buttonRef={materialSwitch} title="Material You" icon="handDrawFill" tint={settingsTint.nightShade} value={material} divider onChange={changeMaterialYou} /> : null}
        <NavRow title="Site Settings" icon="globe" tint={settingsTint.neutral} divider onPress={() => pushSettings({ page: "siteSettings" })} />
        {offersDefault ? <NavRow title="Default Browser" icon="safariFill" tint={settingsTint.defaultBrowser} divider onPress={() => pushSettings({ page: "defaultBrowser" })} /> : null}
        <PickerRow title="Open App Links In" icon="arrowUpForwardAppFill" tint={settingsTint.appLinks} options={APP_LINKS} selected={appLinks} onSelect={setAppLinks} />
      </Group>
      <Group header="Search">
        <NavRow title="Search Engine" icon="magnifyingglass" tint={settingsTint.search} value={engineName} divider onPress={() => pushSettings({ page: "searchEngine" })} />
        <ToggleRow title="Search Suggestions" icon="textMagnifyingglass" tint={settingsTint.blue} value={suggestions} divider onChange={setSearchSuggestions} />
        <ToggleRow title="Auto-Open Keyboard" icon="keyboardFill" tint={settingsTint.keyboard} value={keyboard} onChange={setAutoOpenKeyboard} />
      </Group>
      <Group header="Tabs">
        <PickerRow title="Archive Inactive Tabs" icon="archivebox" tint={settingsTint.archive} options={INTERVALS} selected={interval} divider onSelect={setArchiveInterval} />
        {material ? (
          <NavRow title="Export Open Tabs" icon="squareAndArrowUp" tint={settingsTint.export} onPress={exportOpenTabs} />
        ) : (
          <Pressable accessibilityRole="button" onPress={exportOpenTabs} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
            <IconTile icon="squareAndArrowUp" tint={settingsTint.export} />
            <Text style={[font.body, { color: theme.label }]}>Export Open Tabs</Text>
          </Pressable>
        )}
      </Group>
      <Group header="Privacy">
        <NavRow title="Clear Browsing Data" icon="eraserFill" tint={settingsTint.clearData} divider onPress={() => pushSettings({ page: "clearData" })} />
        <ToggleRow
          title={PHONE_SHARING_COPY.toggle}
          icon="checkmarkShield"
          tint={settingsTint.neutral}
          value={sharing}
          divider
          onChange={(on) => setUsageSharing(on, "settings")}
        />
        <NavRow title={PHONE_SHARING_COPY.whatsSent} icon="info" tint={settingsTint.neutral} onPress={() => pushSettings({ page: "whatsSent" })} />
      </Group>
      {offersBrowseForMe || offersSummaryChoice ? (
        <Group header="Experimental">
          {offersBrowseForMe ? (
            <NavRow title="Browse for Me" icon="sparkleMagnifyingglass" tint={settingsTint.nightShade} value={browseForMeRowValue(chatGPT)} divider={offersSummaryChoice} onPress={() => pushSettings({ page: "browseForMe" })} />
          ) : null}
          {offersSummaryChoice ? (
            <NavRow title="Pinch to Summarize" icon="sparkles" tint={settingsTint.nightShade} value={pageSummaryRowValue(summaries, summaryProvider, chatGPT)} onPress={() => pushSettings({ page: "pageSummary" })} />
          ) : null}
        </Group>
      ) : null}
      <Group header="About">
        {material ? <NavRow title="Show Onboarding" icon="handWave" onPress={showOnboardingFromSettings} /> : null}
        {material ? null : <Pressable accessibilityRole="button" onPress={showOnboardingFromSettings} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
          <IconTile icon="handWave" tint={settingsTint.onboarding} />
          <Text style={[font.body, { color: theme.label }]}>Show Onboarding</Text>
        </Pressable>}
        {material ? null : <View style={[styles.divider, { backgroundColor: theme.separator }]} />}
        <NavRow title="About Ardia" icon="info" tint={settingsTint.neutral} onPress={() => pushSettings({ page: "about" })} />
      </Group>
      <Text style={[font.footnote, styles.centered, { color: theme.secondaryLabel }]}>{appVersion()}</Text>
    </SettingsPage>
  );
}

function SyncCard({ stacks }: { stacks: boolean }) {
  const theme = useTheme();
  const warningInk = useWarningInk();
  const status = useSyncStatus();
  const line = syncRowSubtitle(status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={destinationWords.sync}
      accessibilityValue={{ text: line.text }}
      onPress={() => pushSettings({ page: "sync" })}
      style={({ pressed }) => [styles.syncCard, pressed ? { backgroundColor: theme.rowHighlight } : null]}
    >
      <View testID="syncCardContent" style={[styles.fill, stacks ? styles.syncStacked : styles.syncBeside]}>
        <IconTile icon="macAndPhone" tint={settingsTint.sync} side={stacks ? settingsLayout.syncTileLarge : settingsLayout.syncTile} />
        <View style={styles.syncText}>
          <Text style={[font.title3, styles.bold, { color: theme.label }]}>{destinationWords.sync}</Text>
          <LayoutAnimationConfig skipEntering>
            <Animated.Text
              key={line.text}
              testID="syncStatusLine"
              entering={FadeIn.duration(duration.crossfade)}
              exiting={FadeOut.duration(duration.crossfade)}
              style={[font.subheadline, { color: line.isWarning ? warningInk : theme.secondaryLabel }]}
              numberOfLines={stacks ? undefined : 2}
            >
              {line.text}
            </Animated.Text>
          </LayoutAnimationConfig>
        </View>
      </View>
      <Symbol name="chevronRight" size={14} color={theme.tertiaryLabel} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shortcuts: { paddingHorizontal: space.l, gap: space.s },
  fill: { flex: 1 },
  shortcut: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s, minHeight: 48, borderRadius: controlRadius(48), borderCurve: "continuous" },
  medium: { fontWeight: "500" },
  bold: { fontWeight: "600" },
  syncCard: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m },
  syncText: { flexShrink: 1, gap: space.tight },
  syncBeside: { flexDirection: "row", alignItems: "center", gap: space.s + 2 },
  syncStacked: { flexDirection: "column", alignItems: "flex-start", gap: space.s },
  row: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: settingsLayout.rowInset + settingsLayout.tile + settingsLayout.labelGap },
  centered: { textAlign: "center" },
});
