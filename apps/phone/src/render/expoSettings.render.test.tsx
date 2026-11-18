import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { SettingsShortcuts } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import * as deckGrid from "../state/browse/deckGrid";
import { writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import * as telemetry from "../state/telemetry/telemetry";
import { openSettings, pushSettings, settingsNav } from "../state/settings/nav";
import { usePreferences } from "../state/settings/store";
import { PHONE_SHARING_COPY } from "../lib/telemetryCopy";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

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
const titlesIn = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.title === "string" && typeof inner.props.systemImage === "string").map((inner) => inner.props.title as string);
const toggleFor = (root: Root, title: string) => hosts(root, (props) => typeof props.isOn === "boolean").find((node) => titlesIn(node).includes(title))!;

onIos("on iPhone Settings is a native stack whose root lists main's rows in main's order, Default Browser when it's offered, and our usage-sharing rows before Show Onboarding", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  const rows = titlesIn(stackOf(root));
  expect(rows).toEqual([
    "Appearance",
    "Site Settings",
    "Default Browser",
    "Search Engine",
    "Search Suggestions",
    "Auto-Open Keyboard",
    "Archive Inactive Tabs",
    "Open App Links In",
    "Clear Browsing Data",
    "Export Open Tabs",
    PHONE_SHARING_COPY.toggle,
    PHONE_SHARING_COPY.whatsSent,
    "Show Onboarding",
    "About Ardia",
  ]);
  const links = hosts(root, (props) => typeof props.value === "string" && !("path" in props)).map((node) => node.props.value);
  expect(links).toEqual(["sync", "appearance", "siteSettings", "defaultBrowser", "searchEngine", "clearData", "whatsSent", "about"]);
  unmount(root);
});

onIos("the native stack's path is the settings store's stack, so a push from any page slides in natively, and a native back pops the store", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  expect(stackOf(root).props.path).toEqual([]);
  act(() => pushSettings({ page: "appearance" }));
  expect(stackOf(root).props.path).toEqual(["appearance"]);
  const destination = hosts(root, (props) => props.name === "destination" && (props.extraProps as { value?: string } | undefined)?.value === "appearance")[0]!;
  expect(destination.findAll((node) => typeof node.type === "string" && node.props.title === "Interface Style")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "settingsTitle")).toHaveLength(0);
  act(() => stackOf(root).props.onPathChange({ nativeEvent: { path: [] } }));
  expect(settingsNav().stack).toEqual([{ page: "root" }]);
  unmount(root);
});

onIos("a switch on the root writes its preference, and Done closes Settings", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  const before = usePreferences.getState().searchSuggestions;
  act(() => toggleFor(root, "Search Suggestions").props.onIsOnChange({ nativeEvent: { isOn: !before } }));
  expect(usePreferences.getState().searchSuggestions).toBe(!before);
  const done = hosts(root, (props) => typeof props.onButtonPress === "function" || typeof props.onPress === "function").find((node) => node.findAll((inner) => inner.props.text === "Done" || inner.props.children === "Done").length > 0);
  expect(done).toBeDefined();
  act(() => (done!.props.onButtonPress ?? done!.props.onPress)({ nativeEvent: {} }));
  expect(settingsNav().open).toBe(false);
  unmount(root);
});

onIos("on iPhone Appearance is main's page on Expo UI: Color with nine swatches, Interface Style and Light or Dark with main's footers, the chosen rows marked selected, and a tap writing the choice", () => {
  openSettings({ page: "appearance" });
  const root = renderSurface(<SettingsView />);
  const sections = hosts(root, (props) => typeof props.title === "string" && ["Interface Style", "Light or Dark"].includes(props.title as string));
  expect(sections.map((node) => node.props.title)).toEqual(["Interface Style", "Light or Dark"]);
  const footers = hosts(root, (props) => typeof props.text === "string" && (props.text as string).startsWith("Match My Mac follows your Mac.")).map((node) => node.props.text);
  expect(footers).toEqual(["Match My Mac follows your Mac. Reduce Transparency in iOS Settings always uses Classic.", "Match My Mac follows your Mac. System follows this device."]);
  const buttons = (root: Root) => hosts(root, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "accessibilityAddTraits"));
  const traitsOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; traits?: string[] }[]).find((modifier) => modifier.$type === "accessibilityAddTraits")?.traits ?? []);
  expect(buttons(root).length).toBe(9 + 3 + 4 + 2);
  expect(buttons(root).filter((node) => traitsOf(node).includes("isSelected"))).toHaveLength(4);
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
  expect(buttons.length).toBe(9 + 2 + 3 + 2);
  const selected = buttons.filter((node) => traitsOf(node).includes("isSelected")).flatMap((node) => node.findAll((inner) => typeof inner.props.text === "string").map((inner) => inner.props.text as string));
  expect(selected.some((text) => text.startsWith("Glass"))).toBe(true);
  expect(selected.some((text) => text.startsWith("System"))).toBe(true);
  unmount(root);
  jest.restoreAllMocks();
});

onIos("on iPhone Appearance ends with main's Tabs section: Stack and Grid as checkmark rows with main's footer, Stack chosen by default, and a tap switching the deck's style and remembering it", () => {
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  openSettings({ page: "appearance" });
  const root = renderSurface(<SettingsView />);
  const sections = hosts(root, (props) => typeof props.title === "string" && ["Interface Style", "Light or Dark", "Tabs"].includes(props.title as string));
  expect(sections.map((node) => node.props.title)).toEqual(["Interface Style", "Light or Dark", "Tabs"]);
  const tabs = sections[2]!;
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

onIos("Archive and Spaces are main's own SwiftUI buttons, the settings piece SettingsShortcuts, so a screen reader finds both; each opens its surface; the Sync row has main's 6-point vertical padding and 14-point gap", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  const piece = root.root.findAll((node) => node.type === SettingsShortcuts)[0]!;
  expect(piece.props.shortcuts).toEqual([{ id: "archive", title: "Archive" }, { id: "spaces", title: "Spaces" }]);
  act(() => piece.props.onPress("spaces"));
  act(() => jest.advanceTimersByTime(600));
  expect(useBrowse.getState().sheet).toBe("spaces");
  unmount(root);
  openSettings();
  const again = renderSurface(<SettingsView />);
  const syncStack = again.root.findAll((node) => typeof node.type === "string" && node.props.spacing === 14 && Array.isArray(node.props.modifiers) && (node.props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "padding"))[0];
  expect((syncStack?.props.modifiers as { $type: string; vertical?: number }[]).find((modifier) => modifier.$type === "padding")?.vertical).toBe(6);
  unmount(again);
});
