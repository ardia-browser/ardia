import { useEffect, type ReactNode } from "react";
import { PlatformColor } from "react-native";
import { Button, Form, LabeledContent, NavigationLink, Picker, Section, Text, Toggle } from "@expo/ui/swift-ui";
import { navigationBarTitleDisplayMode, navigationTitle, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { offersDefaultBrowser } from "../../state/settings/settingsRules";
import { useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName } from "../../state/sync/syncRules";
import { showOnboarding } from "../../state/onboarding/store";
import { exportOpenTabs, setAppLinks, setArchiveInterval, setAutoOpenKeyboard, setSearchSuggestions, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { settingsRouteKey, type SettingsRoute } from "../../state/settings/nav";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { TABS_STYLE_FOOTER } from "../../lib/appearance";
import { setUsageSharing, useUsageSharing } from "../../state/telemetry/telemetry";
import { setDeckGrid, useDeckGrid } from "../../state/browse/deckGrid";
import { useIncognito } from "../../state/tabs/hooks";
import { browseForMeOffered, refreshChatGPTConnected, useChatGPTConnected } from "../../state/browseForMe/store";
import { pageSummariesSwitchable, refreshPageSummariesEnabled, setPageSummariesEnabled, usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { PAGE_SUMMARY_COPY } from "../../state/pageSummary/copy";
import { countUsage } from "../../state/telemetry/telemetry";
import { neverBounces, contentMargins, modifierList, settingsChrome, settingsLayout, settingsSwitchStyle } from "../ui";
import { ExpoRowText } from "./ExpoRowLabel";
import { ExpoChoiceRow } from "./ExpoSettingsParts";

const INTERVALS = (Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[]).map((id) => ({ id, title: autoArchiveTitle(id) }));
const APP_LINKS = [
  { id: "ardia", title: "Ardia" },
  { id: "app", title: "App" },
] as const;

const link = (route: SettingsRoute) => settingsRouteKey(route);

function PaneForm({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => countUsage("settings_panes_opened"), []);
  return (
    <Form modifiers={modifierList(navigationTitle(title), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), neverBounces(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
      {children}
    </Form>
  );
}

export function ExpoGeneralPane() {
  const appLinks = useEngines((s) => s.appLinks);
  const sharing = useUsageSharing((s) => s.sharing);
  const offersDefault = offersDefaultBrowser(useDefaultBrowser((s) => s.status));
  useEffect(() => {
    void refreshDefaultBrowser();
  }, []);
  return (
    <PaneForm title="General">
      {offersDefault ? (
        <Section title="Default browser">
          <NavigationLink value={link({ page: "defaultBrowser" })}>
            <ExpoRowText title="Default browser" description="Make Ardia your default browser." />
          </NavigationLink>
        </Section>
      ) : null}
      <Section title="Links" footer={<Text>Links to apps you have, like YouTube or Maps.</Text>}>
        <Picker
          label={<ExpoRowText title="Open app links in" />}
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
      <Section title="Privacy">
        <NavigationLink value={link({ page: "clearData" })}>
          <ExpoRowText title="Clear browsing data" description="History, cookies and cached files." />
        </NavigationLink>
        <Toggle isOn={sharing} onIsOnChange={(on) => setUsageSharing(on, "settings")} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title={PHONE_SHARING_COPY.toggle} />
        </Toggle>
        <NavigationLink value={link({ page: "whatsSent" })}>
          <ExpoRowText title={PHONE_SHARING_COPY.whatsSent} />
        </NavigationLink>
      </Section>
      <Section title="About">
        <Button onPress={showOnboarding} modifiers={[tint("primary")]}>
          <ExpoRowText title="Set up Ardia again" description="Shows the welcome screens again." />
        </Button>
        <NavigationLink value={link({ page: "about" })}>
          <ExpoRowText title="About Ardia" />
        </NavigationLink>
      </Section>
    </PaneForm>
  );
}

export function ExpoTabsPane() {
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const grid = useDeckGrid();
  const incognito = useIncognito();
  return (
    <PaneForm title="Tabs">
      <Section title="Tab view" footer={<Text>{TABS_STYLE_FOOTER}</Text>}>
        <ExpoChoiceRow title="Stack" checked={!grid} onPress={() => setDeckGrid(false, !incognito)} />
        <ExpoChoiceRow title="Grid" checked={grid} onPress={() => setDeckGrid(true, !incognito)} />
      </Section>
      <Section title="Clean up" footer={<Text>Moves tabs you haven't used in this long to the Archive.</Text>}>
        <Picker
          label={<ExpoRowText title="Archive inactive tabs" />}
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
      </Section>
      <Section title="Export">
        <Button onPress={exportOpenTabs} modifiers={[tint("primary")]}>
          <ExpoRowText title="Export open tabs" description="Share a list of every open tab." />
        </Button>
      </Section>
    </PaneForm>
  );
}

export function ExpoSearchPane() {
  const engineId = usePreferences((p) => p.searchEngineId);
  const suggestions = usePreferences((p) => p.searchSuggestions);
  const keyboard = usePreferences((p) => p.autoOpensKeyboard);
  const engines = useEngines((s) => s.engines);
  const syncEnabled = useSyncEnabled();
  const synced = useSyncView().search;
  const engineName = syncEnabled && synced ? syncedEngineName(synced, engines) : (engines.find((engine) => engine.id === engineId)?.name ?? "");
  return (
    <PaneForm title="Search">
      <Section title="Search engine">
        <NavigationLink value={link({ page: "searchEngine" })}>
          <LabeledContent label={<ExpoRowText title="Search engine" />}>
            <Text>{engineName}</Text>
          </LabeledContent>
        </NavigationLink>
        <Toggle isOn={suggestions} onIsOnChange={setSearchSuggestions} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title="Search suggestions" description="Suggestions from your search engine as you type." />
        </Toggle>
      </Section>
      <Section title="New tabs">
        <Toggle isOn={keyboard} onIsOnChange={setAutoOpenKeyboard} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title="Auto-open keyboard" description="Start typing as soon as Ardia opens." />
        </Toggle>
      </Section>
    </PaneForm>
  );
}

export function ExpoExperimentalPane() {
  const chatGPT = useChatGPTConnected();
  const summaries = usePageSummariesEnabled();
  const switchesSummaries = pageSummariesSwitchable();
  useEffect(() => {
    void refreshChatGPTConnected();
    void refreshPageSummariesEnabled();
  }, []);
  return (
    <PaneForm title="Experimental">
      {browseForMeOffered() ? (
        <Section>
          <NavigationLink value={link({ page: "browseForMe" })}>
            <LabeledContent label={<ExpoRowText title="Browse for Me" />}>
              <Text>{chatGPT ? "ChatGPT" : "On iPhone"}</Text>
            </LabeledContent>
          </NavigationLink>
        </Section>
      ) : null}
      {switchesSummaries ? (
        <Section footer={<Text>{PAGE_SUMMARY_COPY.iPhoneFooter}</Text>}>
          <Toggle isOn={summaries} onIsOnChange={(on) => void setPageSummariesEnabled(on)} modifiers={modifierList(settingsSwitchStyle())}>
            <ExpoRowText title={PAGE_SUMMARY_COPY.title} />
          </Toggle>
        </Section>
      ) : null}
    </PaneForm>
  );
}
