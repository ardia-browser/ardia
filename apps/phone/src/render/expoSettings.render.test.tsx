import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { SettingsShortcuts } from "../components/ui";
import * as deckGrid from "../state/browse/deckGrid";
import { writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import * as telemetry from "../state/telemetry/telemetry";
import { followSettingsPath, openSettings, pushSettings, settingsNav } from "../state/settings/nav";
import { usePreferences } from "../state/settings/store";
import { PHONE_SHARING_COPY } from "../lib/telemetryCopy";
import { appVersion } from "../state/settings/actions";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { pages as platformPages } from "../platform/pages";

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root, has: (props: Record<string, unknown>) => boolean) => root.root.findAll((node) => typeof node.type === "string" && has(node.props));
const stackOf = (root: Root) => hosts(root, (props) => Array.isArray(props.path))[0]!;
const toggleFor = (root: Root, title: string) => hosts(root, (props) => typeof props.isOn === "boolean").find((node) => node.findAll((inner) => inner.props.text === title).length > 0)!;

const paneTitles = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.title === "string" && typeof inner.props.systemImage === "string").map((inner) => inner.props.title as string);
const textsIn = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.text === "string").map((inner) => inner.props.text as string);
const sectionTitles = (node: ReactTestInstance, titles: string[]) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.title === "string" && titles.includes(inner.props.title as string) && !("systemImage" in inner.props)).map((inner) => inner.props.title);
const paneOf = (root: Root, page: string) => hosts(root, (props) => props.name === "destination" && (props.extraProps as { value?: string } | undefined)?.value === page)[0]!;
const linksIn = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.value === "string" && !("path" in inner.props)).map((inner) => inner.props.value);

onIos("on iPhone the Settings root is the Mac's pane list: the Sync card, then General, Tabs, Appearance, Search and Site settings, each a tinted tile linking to its pane, Experimental only when it has something, and nothing else, not even the version", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  expect(paneTitles(stackOf(root))).toEqual(["General", "Tabs", "Appearance", "Search", "Site settings"]);
  expect(linksIn(stackOf(root))).toEqual(["sync", "general", "tabs", "appearance", "search", "siteSettings"]);
  expect(root.root.findAll((node) => node.type === SettingsShortcuts)).toHaveLength(0);
  expect(hosts(root, (props) => typeof props.isOn === "boolean")).toHaveLength(0);
  expect(textsIn(stackOf(root))).not.toContain(appVersion());
  unmount(root);
});

onIos("General holds Default browser when offered, app links, privacy with What's Sent and no sharing summary, and About with Set up Ardia again and About Ardia, each a plain row", () => {
  openSettings({ page: "general" });
  const root = renderSurface(<SettingsView />);
  const pane = paneOf(root, "general");
  expect(sectionTitles(pane, ["Default browser", "Links", "Privacy", "About"])).toEqual(["Default browser", "Links", "Privacy", "About"]);
  const texts = textsIn(pane);
  expect(texts).toEqual(expect.arrayContaining(["Default browser", "Open app links in", "Clear browsing data", PHONE_SHARING_COPY.toggle, PHONE_SHARING_COPY.whatsSent, "Set up Ardia again", "About Ardia"]));
  expect(linksIn(pane)).toEqual(["defaultBrowser", "clearData", "whatsSent", "about"]);
  expect(paneTitles(pane)).toEqual([]);
  expect(texts).not.toContain(PHONE_SHARING_COPY.summary);
  unmount(root);
});

onIos("Tabs holds the tab view, the archive interval and Export open tabs; Search holds the engine, suggestions and the keyboard switch", () => {
  openSettings({ page: "tabs" });
  const tabs = renderSurface(<SettingsView />);
  expect(sectionTitles(paneOf(tabs, "tabs"), ["Tab view", "Clean up", "Export"])).toEqual(["Tab view", "Clean up", "Export"]);
  expect(textsIn(paneOf(tabs, "tabs"))).toEqual(expect.arrayContaining(["Stack", "Grid", "Archive inactive tabs", "Export open tabs"]));
  unmount(tabs);
  openSettings({ page: "search" });
  const search = renderSurface(<SettingsView />);
  expect(textsIn(paneOf(search, "search"))).toEqual(expect.arrayContaining(["Search engine", "Search suggestions", "Auto-open keyboard"]));
  expect(linksIn(paneOf(search, "search"))).toEqual(["searchEngine"]);
  unmount(search);
});

onIos("the native stack's path is the settings store's stack, so a push from any page slides in natively, and a native back pops the store", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  expect(stackOf(root).props.path).toEqual([]);
  act(() => pushSettings({ page: "appearance" }));
  expect(stackOf(root).props.path).toEqual(["appearance"]);
  const destination = hosts(root, (props) => props.name === "destination" && (props.extraProps as { value?: string } | undefined)?.value === "appearance")[0]!;
  expect(destination.findAll((node) => typeof node.type === "string" && node.props.title === "Interface style")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "settingsTitle")).toHaveLength(0);
  act(() => stackOf(root).props.onPathChange({ nativeEvent: { path: [] } }));
  expect(settingsNav().stack).toEqual([{ page: "root" }]);
  unmount(root);
});

onIos("a switch in a pane writes its preference, and Done on the root closes Settings", () => {
  openSettings({ page: "search" });
  const pane = renderSurface(<SettingsView />);
  const before = usePreferences.getState().searchSuggestions;
  act(() => toggleFor(pane, "Search suggestions").props.onIsOnChange({ nativeEvent: { isOn: !before } }));
  expect(usePreferences.getState().searchSuggestions).toBe(!before);
  unmount(pane);
  openSettings();
  const root = renderSurface(<SettingsView />);
  const done = hosts(root, (props) => typeof props.onButtonPress === "function" || typeof props.onPress === "function").find((node) => node.props.label === "Done" || node.findAll((inner) => inner.props.text === "Done" || inner.props.children === "Done").length > 0);
  expect(done).toBeDefined();
  act(() => (done!.props.onButtonPress ?? done!.props.onPress)({ nativeEvent: {} }));
  expect(settingsNav().open).toBe(false);
  unmount(root);
});

onIos("on iPhone Appearance is main's page on Expo UI: Color with nine swatches and Custom, Interface style and Light or dark with main's footers, the chosen rows marked selected, and a tap writing the choice", () => {
  openSettings({ page: "appearance" });
  const root = renderSurface(<SettingsView />);
  const sections = hosts(root, (props) => typeof props.title === "string" && ["Interface style", "Light or dark"].includes(props.title as string));
  expect(sections.map((node) => node.props.title)).toEqual(["Interface style", "Light or dark"]);
  const footers = hosts(root, (props) => typeof props.text === "string" && (props.text as string).startsWith("Match My Mac follows your Mac.")).map((node) => node.props.text);
  expect(footers).toEqual(["Match My Mac follows your Mac. Reduce Transparency in iOS Settings always uses Classic.", "Match My Mac follows your Mac. System follows this device."]);
  const buttons = (root: Root) => hosts(root, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "accessibilityAddTraits"));
  const traitsOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; traits?: string[] }[]).find((modifier) => modifier.$type === "accessibilityAddTraits")?.traits ?? []);
  expect(buttons(root).length).toBe(10 + 3 + 4);
  expect(buttons(root).filter((node) => traitsOf(node).includes("isSelected"))).toHaveLength(3);
  const glass = buttons(root).find((node) => node.findAll((inner) => typeof inner.props.text === "string" && (inner.props.text as string).startsWith("Glass")).length > 0)!;
  act(() => (glass.props.onButtonPress ?? glass.props.onPress)({ nativeEvent: {} }));
  expect(usePreferences.getState().interfaceStyle).toBe("glass");
  unmount(root);
});

onIos("where sync isn't offered, the Expo UI Appearance page has no Match My Mac choices and no Mac footers, and a Match My Mac preference reads as Glass and System", () => {
  jest.spyOn(require("../platform/system"), "syncOffered").mockReturnValue(false);
  usePreferences.setState({ interfaceStyle: "matchMac", schemeChoice: "matchMac" });
  openSettings({ page: "appearance" });
  const root = renderSurface(<SettingsView />);
  const texts = hosts(root, (props) => typeof props.text === "string").map((node) => node.props.text as string);
  expect(texts.filter((text) => text.includes("Mac"))).toEqual([]);
  expect(texts).toContain("System follows this device.");
  const traitsOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; traits?: string[] }[]).find((modifier) => modifier.$type === "accessibilityAddTraits")?.traits ?? []);
  const buttons = hosts(root, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "accessibilityAddTraits"));
  expect(buttons.length).toBe(10 + 2 + 3);
  const selected = buttons.filter((node) => traitsOf(node).includes("isSelected")).flatMap((node) => node.findAll((inner) => typeof inner.props.text === "string").map((inner) => inner.props.text as string));
  expect(selected.some((text) => text.startsWith("Glass"))).toBe(true);
  expect(selected.some((text) => text.startsWith("System"))).toBe(true);
  unmount(root);
  jest.restoreAllMocks();
});

onIos("on iPhone the Tabs pane opens with Tab view, as the Mac's Tabs pane opens with its layout: Stack and Grid as checkmark rows with main's footer, Stack chosen by default, and a tap switching the deck's style and remembering it", () => {
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  openSettings({ page: "tabs" });
  const root = renderSurface(<SettingsView />);
  const tabs = hosts(root, (props) => props.title === "Tab view")[0]!;
  expect(tabs.findAll((node) => typeof node.type === "string" && node.props.text === "How your open tabs are laid out. Swipe up on the bottom bar to see them.")).toHaveLength(1);
  const rows = tabs.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.modifiers) && (node.props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "accessibilityAddTraits"));
  const traitsOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; traits?: string[] }[]).find((modifier) => modifier.$type === "accessibilityAddTraits")?.traits ?? []);
  const titleOf = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.props.title === "string" || typeof inner.props.text === "string").map((inner) => (inner.props.title ?? inner.props.text) as string)[0]?.replace(" ✓", "");
  expect(rows.map(titleOf)).toEqual(["Stack", "Grid"]);
  expect(rows.map((node) => traitsOf(node).includes("isSelected"))).toEqual([true, false]);
  const press = (node: ReactTestInstance) => act(() => (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));
  press(rows[1]!);
  expect(deckGrid.deckIsGrid()).toBe(true);
  expect(counted).toHaveBeenCalledWith("deck_grid_shown");
  press(rows[0]!);
  expect(deckGrid.deckIsGrid()).toBe(false);
  unmount(root);
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  counted.mockRestore();
});

onIos("the Sync card keeps main's 6-point vertical padding and 14-point gap", () => {
  openSettings();
  const again = renderSurface(<SettingsView />);
  const syncStack = again.root.findAll((node) => typeof node.type === "string" && node.props.spacing === 14 && Array.isArray(node.props.modifiers) && (node.props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "padding"))[0];
  expect((syncStack?.props.modifiers as { $type: string; vertical?: number }[]).find((modifier) => modifier.$type === "padding")?.vertical).toBe(6);
  unmount(again);
});

const TITLE_TYPES = ["navigationTitle", "ardia.settingsPage"];
const titleModifierOf = (node: ReactTestInstance) => {
  const holder = node.findAll((inner) => typeof inner.type === "string" && Array.isArray(inner.props.modifiers) && (inner.props.modifiers as ({ $type: string } | null)[]).some((modifier) => modifier !== null && TITLE_TYPES.includes(modifier.$type)))[0];
  return holder ? (holder.props.modifiers as ({ $type: string; title?: string } | null)[]).find((modifier) => modifier !== null && TITLE_TYPES.includes(modifier.$type)) ?? null : null;
};
const firstFrameTitle = (node: ReactTestInstance) => {
  const modifier = titleModifierOf(node);
  return modifier === null || modifier.$type === "ardia.settingsPage" ? "" : (modifier.title ?? "");
};
const isPlaceholder = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && Array.isArray(inner.props.modifiers) && (inner.props.modifiers as ({ $type: string } | null)[]).some((modifier) => modifier?.$type === "accessibilityHidden")).length > 0 && textsIn(node).length === 0;
const destinationKeys = (root: Root) => hosts(root, (props) => props.name === "destination").map((node) => (node.props.extraProps as { value: string }).value);

const quietNativeReads = () => {
  jest.spyOn(platformPages, "listsSitePermissions").mockReturnValue(false);
  jest.spyOn(platformPages, "clearsWebsiteDataSince").mockReturnValue(false);
};

onIos("every page a Settings screen links to is mounted before the tap with the same first-frame title the page itself shows, hero or inline, and is hidden from VoiceOver until pushed", () => {
  quietNativeReads();
  const tops = [{ page: "root" }, { page: "general" }, { page: "appearance" }, { page: "search" }, { page: "siteSettings" }, { page: "sync" }, { page: "about" }] as const;
  let compared = 0;
  for (const top of tops) {
    openSettings(top);
    const root = renderSurface(<SettingsView />);
    const pushed = new Set<string>(top.page === "root" ? [] : [top.page]);
    const links = destinationKeys(root).filter((key) => !pushed.has(key));
    for (const key of links) {
      const placeholder = paneOf(root, key);
      expect(isPlaceholder(placeholder)).toBe(true);
      const before = firstFrameTitle(placeholder);
      act(() => pushSettings({ page: key } as never));
      expect(isPlaceholder(paneOf(root, key))).toBe(false);
      expect(`${key}: ${firstFrameTitle(paneOf(root, key))}`).toBe(`${key}: ${before}`);
      compared += 1;
      act(() => followSettingsPath(top.page === "root" ? [] : [top.page]));
    }
    unmount(root);
  }
  expect(compared).toBeGreaterThan(10);
});

onIos("a pane being popped keeps its real content through the pop instead of turning back into its placeholder", () => {
  openSettings({ page: "general" });
  const root = renderSurface(<SettingsView />);
  expect(isPlaceholder(paneOf(root, "general"))).toBe(false);
  act(() => followSettingsPath([]));
  expect(settingsNav().stack.map((route) => route.page)).toEqual(["root"]);
  expect(isPlaceholder(paneOf(root, "general"))).toBe(false);
  expect(textsIn(paneOf(root, "general"))).toContain("About Ardia");
  unmount(root);
});
