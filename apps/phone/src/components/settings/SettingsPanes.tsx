import { useEffect, type ReactNode } from "react";
import { refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { offersDefaultBrowser } from "../../state/settings/settingsRules";
import { useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName } from "../../state/sync/syncRules";
import { showOnboardingFromSettings } from "../../state/onboarding/store";
import { exportOpenTabs, setAppLinks, setArchiveInterval, setAutoOpenKeyboard, setSearchSuggestions, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { popSettings, pushSettings, type SettingsRoute } from "../../state/settings/nav";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { TABS_STYLE_FOOTER } from "../../lib/appearance";
import { countUsage, setUsageSharing, useUsageSharing } from "../../state/telemetry/telemetry";
import { setDeckGrid, useDeckGrid } from "../../state/browse/deckGrid";
import { useIncognito } from "../../state/tabs/hooks";
import { browseForMeOffered, refreshChatGPTConnected, useChatGPTConnected } from "../../state/browseForMe/store";
import { browseForMeRowValue } from "../../state/browseForMe/copy";
import { pageSummaryChoiceOffered, refreshPageSummaryProvider, usePageSummaryProvider } from "../../state/pageSummary/store";
import { PAGE_SUMMARY_COPY, pageSummaryRowValue } from "../../state/pageSummary/copy";
import { refreshPageSummariesEnabled, usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { settingsTint, type SymbolName } from "../ui";
import { CheckRow } from "./AppearancePage";
import { Group, NavRow, PickerRow, SettingsPage, ToggleRow } from "./SettingsKit";
import { useUpdateDot } from "../../state/appUpdate/store";

type PanePage = Extract<SettingsRoute["page"], "general" | "tabs" | "appearance" | "search" | "siteSettings" | "experimental">;

type PaneLook = { page: PanePage; title: string; icon: SymbolName; tint: string };

export const SETTINGS_PANES: readonly PaneLook[] = [
  { page: "general", title: "General", icon: "gearshapeFill", tint: settingsTint.neutral },
  { page: "tabs", title: "Tabs", icon: "squareOnSquareFill", tint: settingsTint.orange },
  { page: "appearance", title: "Appearance", icon: "circleLefthalfFill", tint: settingsTint.nightShade },
  { page: "search", title: "Search", icon: "magnifyingglass", tint: settingsTint.blue },
  { page: "siteSettings", title: "Site settings", icon: "globe", tint: settingsTint.bottomBar },
  { page: "experimental", title: "Experimental", icon: "sparkles", tint: settingsTint.purple },
];

export const experimentalPaneOffered = () => browseForMeOffered() || pageSummaryChoiceOffered();

const paneShown = (pane: PaneLook) => pane.page !== "experimental" || experimentalPaneOffered();

const APP_LINKS = [
  { id: "ardia" as const, title: "Ardia" },
  { id: "app" as const, title: "App" },
];

const INTERVALS = (Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[]).map((id) => ({ id, title: autoArchiveTitle(id) }));

export function SettingsPaneList() {
  const panes = SETTINGS_PANES.filter(paneShown);
  const updateDot = useUpdateDot();
  return (
    <Group>
      {panes.map((pane, index) => (
        <NavRow key={pane.page} title={pane.title} icon={pane.icon} tint={pane.tint} dot={pane.page === "general" && updateDot} divider={index < panes.length - 1} onPress={() => pushSettings({ page: pane.page })} />
      ))}
    </Group>
  );
}

function Pane({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => countUsage("settings_panes_opened"), []);
  return (
    <SettingsPage title={title} onBack={popSettings}>
      {children}
    </SettingsPage>
  );
}

export function GeneralPane() {
  const updateDot = useUpdateDot();
  const appLinks = useEngines((s) => s.appLinks);
  const sharing = useUsageSharing((s) => s.sharing);
  const offersDefault = offersDefaultBrowser(useDefaultBrowser((s) => s.status));
  useEffect(() => {
    void refreshDefaultBrowser();
  }, []);
  return (
    <Pane title="General">
      {offersDefault ? (
        <Group header="Default browser">
          <NavRow title="Default browser" detail="Make Ardia your default browser." onPress={() => pushSettings({ page: "defaultBrowser" })} />
        </Group>
      ) : null}
      <Group header="Links" footer="Links to apps you have, like YouTube or Maps.">
        <PickerRow title="Open app links in" options={APP_LINKS} selected={appLinks} onSelect={setAppLinks} />
      </Group>
      <Group header="Privacy">
        <NavRow title="Clear browsing data" detail="History, cookies and cached files." divider onPress={() => pushSettings({ page: "clearData" })} />
        <ToggleRow title={PHONE_SHARING_COPY.toggle} value={sharing} divider onChange={(on) => setUsageSharing(on, "settings")} />
        <NavRow title={PHONE_SHARING_COPY.whatsSent} onPress={() => pushSettings({ page: "whatsSent" })} />
      </Group>
      <Group header="About">
        <NavRow title="Set up Ardia again" detail="Shows the welcome screens again." chevron={false} divider onPress={showOnboardingFromSettings} />
        <NavRow title="About Ardia" dot={updateDot} onPress={() => pushSettings({ page: "about" })} />
      </Group>
    </Pane>
  );
}

export function TabsPane() {
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const material = usePreferences((p) => p.materialYou);
  const grid = useDeckGrid() && !material;
  const incognito = useIncognito();
  return (
    <Pane title="Tabs">
      <Group header="Tab view" footer={material ? "Grid is available with Material You off." : TABS_STYLE_FOOTER}>
        <CheckRow title="Stack" checked={!grid} disabled={material} divider onPress={() => setDeckGrid(false, !incognito)} />
        <CheckRow title="Grid" checked={grid} disabled={material} divider={false} onPress={() => setDeckGrid(true, !incognito)} />
      </Group>
      <Group header="Clean up" footer="Moves tabs you haven't used in this long to the Archive.">
        <PickerRow title="Archive inactive tabs" options={INTERVALS} selected={interval} onSelect={setArchiveInterval} />
      </Group>
      <Group header="Export">
        <NavRow title="Export open tabs" detail="Share a list of every open tab." chevron={false} onPress={exportOpenTabs} />
      </Group>
    </Pane>
  );
}

export function SearchPane() {
  const engineId = usePreferences((p) => p.searchEngineId);
  const suggestions = usePreferences((p) => p.searchSuggestions);
  const keyboard = usePreferences((p) => p.autoOpensKeyboard);
  const engines = useEngines((s) => s.engines);
  const syncEnabled = useSyncEnabled();
  const synced = useSyncView().search;
  const engineName = syncEnabled && synced ? syncedEngineName(synced, engines) : (engines.find((engine) => engine.id === engineId)?.name ?? "");
  return (
    <Pane title="Search">
      <Group header="Search engine">
        <NavRow title="Search engine" value={engineName} divider onPress={() => pushSettings({ page: "searchEngine" })} />
        <ToggleRow title="Search suggestions" detail="Suggestions from your search engine as you type." value={suggestions} onChange={setSearchSuggestions} />
      </Group>
      <Group header="New tabs">
        <ToggleRow title="Auto-open keyboard" detail="Start typing as soon as Ardia opens." value={keyboard} onChange={setAutoOpenKeyboard} />
      </Group>
    </Pane>
  );
}

export function ExperimentalPane() {
  const chatGPT = useChatGPTConnected();
  const summaryProvider = usePageSummaryProvider();
  const summaries = usePageSummariesEnabled();
  useEffect(() => {
    void refreshChatGPTConnected();
    void refreshPageSummaryProvider();
    void refreshPageSummariesEnabled();
  }, []);
  return (
    <Pane title="Experimental">
      {browseForMeOffered() ? (
        <Group>
          <NavRow title="Browse for Me" value={browseForMeRowValue(chatGPT)} onPress={() => pushSettings({ page: "browseForMe" })} />
        </Group>
      ) : null}
      {pageSummaryChoiceOffered() ? (
        <Group>
          <NavRow title={PAGE_SUMMARY_COPY.title} value={pageSummaryRowValue(summaries, summaryProvider, chatGPT)} onPress={() => pushSettings({ page: "pageSummary" })} />
        </Group>
      ) : null}
    </Pane>
  );
}
