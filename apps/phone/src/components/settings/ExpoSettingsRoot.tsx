import { useEffect } from "react";
import { PlatformColor } from "react-native";
import { Button, Form, HStack, Image, LabeledContent, NavigationLink, Picker, Section, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityElement, contentTransition, font, foregroundStyle, frame, listRowBackground, listRowInsets, listSectionSpacing, multilineTextAlignment, navigationBarTitleDisplayMode, navigationTitle, padding, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { offersDefaultBrowser } from "../../state/settings/settingsRules";
import { openArchive, openSpaces } from "../../state/browse/store";
import { useSyncEnabled, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName, syncRowSubtitle } from "../../state/sync/syncRules";
import { showOnboarding } from "../../state/onboarding/store";
import { appVersion, exportOpenTabs, setAppLinks, setArchiveInterval, setAutoOpenKeyboard, setSearchSuggestions, useEngines } from "../../state/settings/actions";
import { useAppearanceSummary } from "../../state/settings/appearance";
import { usePreferences } from "../../state/settings/hooks";
import { closeSettings, settingsRouteKey, type SettingsRoute } from "../../state/settings/nav";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { prepareArchiveNextFrame } from "../../state/tabs/store";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { setUsageSharing, useUsageSharing } from "../../state/telemetry/telemetry";
import { contentMargins, modifierList, PROFILE_COLORS, settingsChrome, settingsLayout, SettingsIconTile, SettingsShortcuts, settingsSwitchStyle, settingsTint, settingsUIAvailable, useWarningInk, type ProfileColor } from "../ui";
import { ExpoRowLabel } from "./ExpoRowLabel";
import { ExpoSettingsDone } from "./ExpoSettingsDone";
import { syncOffered } from "../../state/sync/offer";
import { browseForMeOffered, refreshChatGPTConnected, useChatGPTConnected } from "../../state/browseForMe/store";
import { pageSummariesSwitchable, refreshPageSummariesEnabled, setPageSummariesEnabled, usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { PAGE_SUMMARY_COPY } from "../../state/pageSummary/copy";
import { destinationWords } from "../../lib/sharedWords";

const INTERVALS = (Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[]).map((id) => ({ id, title: autoArchiveTitle(id) }));
const APP_LINKS = [
  { id: "ardia", title: "Ardia" },
  { id: "app", title: "App" },
] as const;
const SHORTCUTS = [{ id: "archive", title: destinationWords.archive }, { id: "spaces", title: destinationWords.spaces }];
const ARCHIVE_ONLY = SHORTCUTS.filter((shortcut) => shortcut.id === "archive");
const SYNC_TILE = 56;
const TOP_SECTION_SPACING = 12;

const link = (route: SettingsRoute) => settingsRouteKey(route);
const colorName = (choice: string) => (choice === "custom" ? "Custom" : (PROFILE_COLORS[choice as ProfileColor]?.name ?? choice));

export function ExpoSettingsRoot() {
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
  const appearance = useAppearanceSummary(colorName);
  const chatGPT = useChatGPTConnected();
  const summaries = usePageSummariesEnabled();
  const switchesSummaries = pageSummariesSwitchable();
  useEffect(() => {
    void refreshChatGPTConnected();
    void refreshPageSummariesEnabled();
  }, []);
  return (
    <ExpoSettingsDone>
      <Form modifiers={modifierList(navigationTitle(destinationWords.settings), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
        {syncOffered() ? (
          <Section modifiers={[listSectionSpacing(TOP_SECTION_SPACING)]}>
            <NavigationLink value={link({ page: "sync" })}>
              <SyncRow />
            </NavigationLink>
          </Section>
        ) : null}
        <Section modifiers={[listRowBackground("clear"), listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }), listSectionSpacing(TOP_SECTION_SPACING)]}>
          <SettingsShortcuts shortcuts={syncOffered() ? SHORTCUTS : ARCHIVE_ONLY} onPress={(id) => leaveFor(id === "archive" ? openPreparedArchive : openSpaces)} />
        </Section>
        <Section title="General">
          <NavigationLink value={link({ page: "appearance" })}>
            <LabeledContent label={<ExpoRowLabel title="Appearance" systemImage="paintpalette.fill" tint="swatch" />}>
              <Text>{appearance}</Text>
            </LabeledContent>
          </NavigationLink>
          <NavigationLink value={link({ page: "siteSettings" })}>
            <ExpoRowLabel title="Site Settings" systemImage="globe" tint="neutral" />
          </NavigationLink>
          {offersDefault ? (
            <NavigationLink value={link({ page: "defaultBrowser" })}>
              <ExpoRowLabel title="Default Browser" systemImage="safari.fill" tint="defaultBrowser" />
            </NavigationLink>
          ) : null}
          <Picker
            label={<ExpoRowLabel title="Open App Links In" systemImage="arrow.up.forward.app.fill" tint="appLinks" />}
            selection={appLinks}
            onSelectionChange={(next: (typeof APP_LINKS)[number]["id"]) => setAppLinks(next)}
            modifiers={[pickerStyle("menu"), tint("secondary")]}
          >
            {APP_LINKS.map((option) => (
              <Text key={option.id} modifiers={[tag(option.id)]}>
                {option.title}
              </Text>
            ))}
          </Picker>
        </Section>
        <Section title="Search">
          <NavigationLink value={link({ page: "searchEngine" })}>
            <LabeledContent label={<ExpoRowLabel title="Search Engine" systemImage="magnifyingglass" tint="search" />}>
              <Text>{engineName}</Text>
            </LabeledContent>
          </NavigationLink>
          <Toggle isOn={suggestions} onIsOnChange={setSearchSuggestions} modifiers={modifierList(settingsSwitchStyle())}>
            <ExpoRowLabel title="Search Suggestions" systemImage="text.magnifyingglass" tint="blue" />
          </Toggle>
          <Toggle isOn={keyboard} onIsOnChange={setAutoOpenKeyboard} modifiers={modifierList(settingsSwitchStyle())}>
            <ExpoRowLabel title="Auto-Open Keyboard" systemImage="keyboard.fill" tint="keyboard" />
          </Toggle>
        </Section>
        <Section title="Tabs">
          <Picker
            label={<ExpoRowLabel title="Archive Inactive Tabs" systemImage="archivebox.fill" tint="archive" />}
            selection={interval}
            onSelectionChange={(next: AutoArchiveInterval) => setArchiveInterval(next)}
            modifiers={[pickerStyle("menu"), tint("secondary")]}
          >
            {INTERVALS.map((option) => (
              <Text key={option.id} modifiers={[tag(option.id)]}>
                {option.title}
              </Text>
            ))}
          </Picker>
          <Button onPress={exportOpenTabs} modifiers={[tint("primary")]}>
            <ExpoRowLabel title="Export Open Tabs" systemImage="square.and.arrow.up.fill" tint="export" />
          </Button>
        </Section>
        <Section title="Privacy">
          <NavigationLink value={link({ page: "clearData" })}>
            <ExpoRowLabel title="Clear Browsing Data" systemImage="eraser.fill" tint="clearData" />
          </NavigationLink>
          <Toggle isOn={sharing} onIsOnChange={(on) => setUsageSharing(on, "settings")} modifiers={modifierList(settingsSwitchStyle())}>
            <ExpoRowLabel title={PHONE_SHARING_COPY.toggle} systemImage="checkmark.shield" tint="neutral" />
          </Toggle>
          <NavigationLink value={link({ page: "whatsSent" })}>
            <ExpoRowLabel title={PHONE_SHARING_COPY.whatsSent} systemImage="info" tint="neutral" />
          </NavigationLink>
        </Section>
        {browseForMeOffered() || switchesSummaries ? (
          <Section title="Experimental" footer={switchesSummaries ? <Text>{PAGE_SUMMARY_COPY.iPhoneFooter}</Text> : undefined}>
            {browseForMeOffered() ? (
              <NavigationLink value={link({ page: "browseForMe" })}>
                <LabeledContent label={<ExpoRowLabel title="Browse for Me" systemImage="sparkle.magnifyingglass" tint="nightShade" />}>
                  <Text>{chatGPT ? "ChatGPT" : "On iPhone"}</Text>
                </LabeledContent>
              </NavigationLink>
            ) : null}
            {switchesSummaries ? (
              <Toggle isOn={summaries} onIsOnChange={(on) => void setPageSummariesEnabled(on)} modifiers={modifierList(settingsSwitchStyle())}>
                <ExpoRowLabel title={PAGE_SUMMARY_COPY.title} systemImage="sparkles" tint="nightShade" />
              </Toggle>
            ) : null}
          </Section>
        ) : null}
        <Section title="About" footer={<Text modifiers={[frame({ maxWidth: Number.MAX_SAFE_INTEGER }), multilineTextAlignment("center")]}>{appVersion()}</Text>}>
          <Button onPress={showOnboarding} modifiers={[tint("primary")]}>
            <ExpoRowLabel title="Show Onboarding" systemImage="hand.wave.fill" tint="onboarding" />
          </Button>
          <NavigationLink value={link({ page: "about" })}>
            <ExpoRowLabel title="About Ardia" systemImage="info" tint="neutral" />
          </NavigationLink>
        </Section>
      </Form>
    </ExpoSettingsDone>
  );
}

function leaveFor(open: () => void) {
  closeSettings();
  open();
}

function openPreparedArchive() {
  openArchive();
  prepareArchiveNextFrame();
}

function SyncRow() {
  const warningInk = useWarningInk();
  const line = syncRowSubtitle(useSyncStatus());
  return (
    <HStack spacing={14} modifiers={[padding({ vertical: 6 }), accessibilityElement("combine")]}>
      {settingsUIAvailable() ? (
        <SettingsIconTile systemImage="macbook.and.iphone" tint="sync" baseSide={SYNC_TILE} />
      ) : (
        <Image systemName="macbook.and.iphone" size={SYNC_TILE / 2} color={settingsTint.sync} />
      )}
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: "headline" })]}>{destinationWords.sync}</Text>
        <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(line.isWarning ? warningInk : { type: "hierarchical", style: "secondary" }), contentTransition("opacity")]}>{line.text}</Text>
      </VStack>
    </HStack>
  );
}
