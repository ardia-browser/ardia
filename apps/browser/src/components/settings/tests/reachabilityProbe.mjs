import { createRequire } from "node:module";

const glass = process.env.ARDIA_TEST_GLASS === "1";
globalThis.acTestNativeModules = { ArdiaGlassEffect: { isLiquidGlass: () => glass } };
createRequire(import.meta.url)("react").useSyncExternalStore = (_subscribe, snapshot) => snapshot();

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const index = await import("../settingsIndex.ts");
const { SETTINGS, findSetting, hiddenFromSearch, unshownSettings, unsupportedSettings } = index;
const unlockOf = index.unlockOf ?? ((entry) => entry.unlock ?? null);
const { SettingsPaneContext, useSettingsEnv } = await import("../Form.tsx");
const { useSettingsSearch } = await import("../../../state/settings/searchState.ts");
const { useSync } = await import("../../../state/sync/engine.ts");
const { useCalendar } = await import("../../../state/live/calendar.ts");
const { useBrowser } = await import("../../../state/browser/store.ts");
const { resetAirTrafficForTests } = await import("../../../state/airTraffic/store.ts");
const { NO_AIR_TRAFFIC } = await import("../../../state/airTraffic/rules.ts");
const { store } = await import("../../../state/settings/resources.ts");
const { appIconChoices, defaultBrowser, updater } = await import("../../../state/settings/paneData.ts");

const PANES = {
  general: (await import("../panes/General.tsx")).GeneralPane,
  profiles: (await import("../panes/Profiles.tsx")).ProfilesPane,
  tabs: (await import("../panes/Tabs.tsx")).TabsPane,
  appearance: (await import("../panes/Appearance.tsx")).AppearancePane,
  automations: (await import("../panes/Automations.tsx")).AutomationsPane,
  plugins: (await import("../panes/Plugins.tsx")).PluginsPane,
  shortcuts: (await import("../panes/Shortcuts.tsx")).ShortcutsPane,
  advanced: (await import("../panes/Advanced.tsx")).AdvancedPane,
};

const UPDATER = { available: true, configured: true, automaticChecks: true, automaticDownloads: true, canCheck: true, sessionInProgress: false, feedURL: null, lastCheck: null, version: "1.0" };
const UPDATERS = { loading: undefined, channels: { ...UPDATER, channel: "stable" }, channelless: UPDATER, none: { available: false } };
const icon = (id) => ({ id, name: id, preview: null });
const ICONS = { loading: undefined, none: { icons: [], current: null }, one: { icons: [icon("a")], current: "a" }, two: { icons: [icon("a"), icon("b")], current: "a" } };

const BASE = { sync: "off", calendar: false, top: false, updater: "channels", icons: "two", fallbackTab: false, settings: {} };
const COMBOS = [];
for (const sync of ["off", "on", "unavailable"]) for (const calendar of [false, true]) for (const top of [false, true]) COMBOS.push({ ...BASE, sync, calendar, top });
for (const updater of Object.keys(UPDATERS)) COMBOS.push({ ...BASE, updater });
for (const icons of Object.keys(ICONS)) COMBOS.push({ ...BASE, icons });
for (const fallbackTab of [false, true]) COMBOS.push({ ...BASE, fallbackTab });
const FLIPS = {
  separateDownloadFolders: [false, true],
  memorySaver: [false, true],
  interfaceStyle: ["glass", "classic"],
  addressBar: ["sidebar", "toolbar"],
  borderlessMode: [false, true],
  newTabOpens: ["page", "commandBar"],
  minimalismMode: [false, true],
  cleanUpInactiveTabsAfterMinutes: [null, 720],
  elementOutlines: [true, false],
};
const FLIPS_WITH_LAYOUT = new Set(["addressBar"]);
for (const [key, values] of Object.entries(FLIPS)) for (const value of values) for (const top of FLIPS_WITH_LAYOUT.has(key) ? [false, true] : [false]) COMBOS.push({ ...BASE, top, settings: { [key]: value } });
COMBOS.push({ ...BASE, settings: { newTabOpens: "page", minimalismMode: true } });

const initial = { ...useBrowser.getState().settings };
store(defaultBrowser, [], false);

let env;
const ReadEnv = () => {
  env = useSettingsEnv();
  return null;
};

const render = (pane) => {
  const settings = useBrowser.getState().settings;
  const place = { pane, profileId: settings.defaultProfileId, detail: null };
  return renderToStaticMarkup(createElement(SettingsPaneContext.Provider, { value: pane }, createElement(PANES[pane], place)));
};

function anchorMarkup(markup, id) {
  const open = `<x-view data-testid="setting:${id}">`;
  const start = markup.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  for (let at = start; at < markup.length; ) {
    const nextOpen = markup.indexOf("<x-view", at);
    const nextClose = markup.indexOf("</x-view>", at);
    if (nextClose < 0) return markup.slice(start);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      at = nextOpen + 7;
    } else {
      depth--;
      at = nextClose + 9;
      if (depth === 0) return markup.slice(start, at);
    }
  }
  return markup.slice(start);
}

const actionable = (fragment) => !!fragment && /<x-press(?![^>]*data-disabled)[^>]*>/.test(fragment);

const describe = (c) =>
  [`sync ${c.sync}`, `calendar ${c.calendar ? "on" : "off"}`, c.top ? "top tabs" : "sidebar", `updater ${c.updater}`, `icons ${c.icons}`, c.fallbackTab ? "fallback opens tabs" : null, ...Object.entries(c.settings).map(([k, v]) => `${k}=${v}`)]
    .filter(Boolean)
    .join(", ");

const failures = [];
for (const combo of COMBOS) {
  useBrowser.getState().updateSettings({ ...initial, tabLayout: combo.top ? "top" : "sidebar", ...combo.settings });
  useSync.setState({ enabled: combo.sync === "on", status: combo.sync === "unavailable" ? "unavailable" : combo.sync === "on" ? "idle" : "off" });
  useCalendar.setState({ access: combo.calendar ? "fixture" : "notDetermined" });
  resetAirTrafficForTests(combo.fallbackTab ? { ...NO_AIR_TRAFFIC, fallback: { profileId: initial.defaultProfileId, open: "tab" } } : NO_AIR_TRAFFIC);
  store(updater, [], UPDATERS[combo.updater]);
  store(appIconChoices, [], ICONS[combo.icons]);
  useSettingsSearch.setState({ query: "", held: null });
  renderToStaticMarkup(createElement(ReadEnv));
  const settings = useBrowser.getState().settings;
  const unshown = new Set(unshownSettings(settings, env).split("\n").filter(Boolean));
  const unsupported = new Set(unsupportedSettings(env).split("\n").filter(Boolean));
  const hidden = hiddenFromSearch(unshown, unsupported);
  const where = describe(combo);
  const panes = new Map(Object.keys(PANES).map((pane) => [pane, render(pane)]));
  for (const entry of SETTINGS.filter((e) => !hidden.has(e.id))) {
    let markup = panes.get(entry.pane);
    if (!anchorMarkup(markup, entry.id) && unshown.has(entry.id)) {
      useSettingsSearch.setState({ query: "probe", held: entry.id });
      markup = render(entry.pane);
      useSettingsSearch.setState({ query: "", held: null });
    }
    if (!anchorMarkup(markup, entry.id)) failures.push(`${entry.id}: offered by search but never mounted (${where})`);
    if (!unshown.has(entry.id)) continue;
    const unlockId = unlockOf(entry, settings);
    const unlock = unlockId ? findSetting(unlockId) : undefined;
    if (!unlock) {
      failures.push(`${entry.id}: locked without an unlocking setting (${where})`);
      continue;
    }
    const target = anchorMarkup(panes.get(unlock.pane), unlock.id);
    if (!target) failures.push(`${entry.id}: unlocks from ${unlock.id}, which isn't mounted (${where})`);
    else if (!actionable(target)) failures.push(`${entry.id}: unlocks from ${unlock.id}, whose control is disabled (${where})`);
  }
}
process.stdout.write(JSON.stringify([...new Set(failures)]));
