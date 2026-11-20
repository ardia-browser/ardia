import { Dimensions, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { DeckBar } from "../components/tabs/DeckBar";
import { IncognitoChip } from "../components/tabs/DeckChrome";
import { TabDeck } from "../components/tabs/TabDeck";
import { ConfirmSheet, DesignProvider, IncognitoSpecs, Symbol, SystemGlyph } from "../components/ui";
import { deckGeometry, redesignedBarCenterFromBottom } from "../lib/deckGeometry";
import { designFor, type Design } from "../lib/design";
import { haptics } from "../state/app/haptics";
import { useArchiveCard } from "../state/browse/archiveCard";
import * as browse from "../state/browse/store";
import * as settingsNav from "../state/settings/nav";
import * as syncActions from "../state/sync/actions";
import { OFF_STATUS, useSync, type SyncedProfile } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import * as tabHooks from "../state/tabs/hooks";
import { useTabs } from "../state/tabs/store";
import { renderSurface, someTabs, textOf, unmount, withTabs } from "../../test/render/harness";

const SAFE_TOP = 40;
const SAFE_BOTTOM = 24;

const profile = (syncId: string, name: string): SyncedProfile => ({
  syncId,
  name,
  color: null,
  icon: null,
  isDefault: syncId === "work",
  theme: null,
  deviceTabs: [],
  pinned: { tiles: [], sections: [] },
  bookmarks: [],
  history: [],
  sendTargets: null,
});

function withSpaces(profiles: SyncedProfile[], selected = profiles[0]?.syncId ?? null) {
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
    view: { devices: [], profiles, search: null, syncedAt: 1, selectedProfileId: selected, shownProfileId: selected, receivers: [] } as never,
  }));
}

const withPrivateTabs = (count: number) => useTabs.setState((state) => ({ ...state, privates: someTabs(count, true) }));

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  useArchiveCard.setState({ showing: false });
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => useArchiveCard.setState({ showing: false }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const deck = (design: Design = "redesigned") =>
  renderSurface(
    <DesignProvider design={design}>
      <TabDeck />
    </DesignProvider>,
  );

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const host = (root: Root, testID: string) => hosts(root, testID)[0];
const style = (root: Root, testID: string) => StyleSheet.flatten(host(root, testID)!.props.style);
const pressable = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!;
const menuLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const pickMenu = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
const cardCentres = (root: Root) =>
  hosts(root, "deckCard").map((card) => {
    const translateY = (getAnimatedStyle(card).transform as { translateY?: number }[]).find((step) => step.translateY !== undefined)!.translateY!;
    return translateY + (StyleSheet.flatten(card.props.style).height as number) / 2;
  });
const searchField = (root: Root) => root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onChangeText === "function")[0]!;
const search = (root: Root, text: string) => act(() => searchField(root).props.onChangeText(text));

test("the original deck keeps its bar and its Incognito chip, and none of the redesign's header, bar or capsule", () => {
  withPrivateTabs(2);
  act(() => useArchiveCard.setState({ showing: true }));
  const root = deck("original");
  expect(root.root.findAll((node) => node.type === DeckBar)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === IncognitoChip)).toHaveLength(1);
  expect(host(root, "deckHeader")).toBeUndefined();
  expect(host(root, "deckBottomBar")).toBeUndefined();
  expect(host(root, "archiveCapsule")).toBeUndefined();
  expect(host(root, "archiveCardPlace")).toBeDefined();
  unmount(root);
});

test("the redesign drops the old bar and chip for main's header and bottom bar", () => {
  withPrivateTabs(2);
  const root = deck();
  expect(root.root.findAll((node) => node.type === DeckBar)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === IncognitoChip)).toHaveLength(0);
  expect(host(root, "deckHeader")).toBeDefined();
  expect(host(root, "deckBottomBar")).toBeDefined();
  unmount(root);
});

test("the redesigned cards sit 24 points lower than the original's on iPhone, centred in the band between main's header and bar; on Android the bar sits where the browsing bar does, so the band's centre rises by half of that lift", () => {
  const { width, height } = Dimensions.get("window");
  const original = deck("original");
  const before = cardCentres(original);
  unmount(original);
  const root = deck();
  const after = cardCentres(root);
  expect(after.length).toBeGreaterThan(0);
  const expected = deckGeometry(width, height, SAFE_TOP, SAFE_BOTTOM, 0, Platform.OS, "redesigned", 48).cardCenterY;
  for (const centre of after) expect(centre).toBeCloseTo(expected, 5);
  const barLift = redesignedBarCenterFromBottom(SAFE_BOTTOM, Platform.OS) - (Math.max(SAFE_BOTTOM, 20) + 11);
  expect(barLift).toBe(Platform.OS === "android" ? 10.5 : 0);
  for (const centre of before) expect(centre).toBeCloseTo(expected - 24 + barLift / 2, 5);
  unmount(root);
});

test("the header is centred 26 points under the safe top, 24 in from the sides like the bottom bar, and its ··· is a 44-point glass circle", () => {
  const root = deck();
  const header = style(root, "deckHeader");
  expect(header.top + header.height / 2).toBe(SAFE_TOP + 26);
  expect(header).toMatchObject({ paddingHorizontal: 24, gap: 8 });
  expect(style(root, "deckBottomBar")).toMatchObject({ paddingLeft: header.paddingHorizontal, paddingRight: header.paddingHorizontal });
  const more = root.root.findAll((node) => Array.isArray(node.props.items) && node.props.place && node.props.items.some((item: { label?: string }) => item?.label === "Settings"))[0]!;
  expect(more.props.place).toMatchObject({ right: 24 });
  expect(style(root, "deckHeaderMore")).toMatchObject({ width: 44, height: 44, borderRadius: 22 });
  unmount(root);
});

test("without spaces the switcher reads Tabs; with one space it is that space's name; with several it opens a menu that switches space", () => {
  const select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  const plain = deck();
  expect(plain.root.findAll((node) => node.props.accessibilityRole === "header" && textOf({ root: node } as Root) === "Tabs")).not.toHaveLength(0);
  unmount(plain);
  withSpaces([profile("work", "Work")]);
  const one = deck();
  expect(one.root.findAll((node) => node.props.accessibilityRole === "header" && node.props.accessibilityLabel === "Work")).not.toHaveLength(0);
  expect(one.root.findAll((node) => node.props.accessibilityLabel === "Space, Work")).toHaveLength(0);
  unmount(one);
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const many = deck();
  act(() => pressable(many, "Space, Work").props.onPress());
  expect(menuLabels(many)).toEqual(["Work", "Home"]);
  pickMenu(many, "Home");
  expect(select).toHaveBeenCalledWith("home");
  unmount(many);
});

test("the ··· menu holds Archive, New Incognito Tab, Close All Tabs and Settings, adding Spaces From Your Mac with sync on and Reopen Closed Tab when there is one", () => {
  const plain = deck();
  act(() => pressable(plain, "More").props.onPress());
  expect(menuLabels(plain)).toEqual(["Archive", "New Incognito Tab", "Close All Tabs", "Settings"]);
  unmount(plain);
  withSpaces([profile("work", "Work")]);
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const full = deck();
  act(() => pressable(full, "More").props.onPress());
  expect(menuLabels(full)).toEqual(["Archive", "Spaces From Your Mac", "New Incognito Tab", "Reopen Closed Tab", "Close All Tabs", "Settings"]);
  unmount(full);
});

test("each ··· row does its action: the Archive and Spaces sheets, a private tab, reopening, Settings, and Close All asks first", () => {
  withSpaces([profile("work", "Work")]);
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const incognito = jest.spyOn(browse, "newIncognitoTab").mockImplementation(() => undefined);
  const reopen = jest.spyOn(browse, "reopenLastClosed").mockImplementation(() => undefined);
  const settings = jest.spyOn(settingsNav, "openSettings").mockImplementation(() => undefined);
  const closeAll = jest.spyOn(browse, "closeAllFromDeck").mockImplementation(() => undefined);
  const root = deck();
  const choose = (label: string) => {
    act(() => pressable(root, "More").props.onPress());
    pickMenu(root, label);
  };
  choose("Archive");
  expect(browse.useBrowse.getState().sheet).toBe("archive");
  act(() => browse.useBrowse.setState({ sheet: null }));
  choose("Spaces From Your Mac");
  expect(browse.useBrowse.getState().sheet).toBe("spaces");
  act(() => browse.useBrowse.setState({ sheet: null }));
  choose("New Incognito Tab");
  expect(incognito).toHaveBeenCalledTimes(1);
  choose("Reopen Closed Tab");
  expect(reopen).toHaveBeenCalledTimes(1);
  choose("Settings");
  expect(settings).toHaveBeenCalledTimes(1);
  choose("Close All Tabs");
  expect(closeAll).not.toHaveBeenCalled();
  const sheet = root.root.findAll((node) => node.type === ConfirmSheet)[0]!;
  expect(sheet.props.confirmation.title).toBe("Close 9 Tabs?");
  act(() => pressable(root, "Close All Tabs").props.onPress());
  expect(closeAll).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the Incognito pill shows only while there are private tabs, with their count, and its menu closes them after asking", () => {
  const none = deck();
  expect(host(none, "deckIncognitoPill")).toBeUndefined();
  unmount(none);
  withPrivateTabs(2);
  const leave = jest.spyOn(browse, "leaveIncognito").mockImplementation(() => undefined);
  const root = deck();
  const pill = host(root, "deckIncognitoPill")!;
  expect(pill.props.accessibilityLabel).toBe("Incognito, 2 tabs");
  expect(textOf({ root: pill } as Root)).toBe("2");
  act(() => pressable(root, "Incognito, 2 tabs").props.onPress());
  expect(menuLabels(root)).toEqual(["Close Incognito Tabs"]);
  pickMenu(root, "Close Incognito Tabs");
  const sheet = root.root.findAll((node) => node.type === ConfirmSheet)[0]!;
  expect(sheet.props.confirmation.title).toBe("Close Incognito Tabs?");
  act(() => pressable(root, "Close Incognito Tabs").props.onPress());
  expect(leave).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the bottom bar is the Incognito switch, the Search Tabs capsule and a 48-point plus, with no grid button, 8 apart, 24 in from the sides, centred 11 points above the safe bottom on iPhone and where the browsing bar sits on Android", () => {
  const { height } = Dimensions.get("window");
  const root = deck();
  const bar = style(root, "deckBottomBar");
  expect(bar).toMatchObject({ height: 48, gap: 8, paddingLeft: 24, paddingRight: 24 });
  let place = host(root, "deckBottomBar")!.parent;
  while (place && StyleSheet.flatten(place.props.style)?.position !== "absolute") place = place.parent;
  const anchor = StyleSheet.flatten(place!.props.style);
  const centerFromBottom = redesignedBarCenterFromBottom(SAFE_BOTTOM, Platform.OS);
  if (Platform.OS === "android") expect(anchor).toMatchObject({ bottom: centerFromBottom - 24 });
  else expect((anchor.top as number) + 24).toBe(height - centerFromBottom);
  expect(host(root, "deckBarGrid")).toBeUndefined();
  expect(style(root, "deckBarIncognito")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(style(root, "deckBarPlus")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(style(root, "deckSearchTabs")).toMatchObject({ borderRadius: 24, paddingLeft: 13, paddingRight: 16 });
  const pieces = ["deckBarIncognito", "deckSearchTabs", "deckBarPlus"];
  const shown = host(root, "deckBottomBar")!.findAll((node) => typeof node.type === "string" && pieces.includes(node.props.testID)).map((node) => node.props.testID);
  expect(shown.filter((id, at) => id !== shown[at - 1])).toEqual(pieces);
  expect(pressable(root, "Show as Grid")).toBeUndefined();
  unmount(root);
});

const incognitoSwitch = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Incognito" && node.props.accessibilityRole === "switch" && typeof node.props.onPress === "function")[0];

test("the bar's left button is an Incognito switch: Arc Search's open eyes, 30 points, drawn on 48-point glass, read as a switch with a hint, on both phones and only in the redesign", () => {
  const root = deck();
  const toggle = incognitoSwitch(root)!;
  expect(toggle.props.accessibilityState).toMatchObject({ checked: false });
  expect(toggle.props.accessibilityHint).toBe("Shows your Incognito tabs.");
  expect(host(root, "deckBarIncognitoGlyph")!.findAll((node) => node.type === Symbol && node.props.name === "eyes" && node.props.size === 30)).toHaveLength(1);
  expect(host(root, "deckBarIncognitoGlyph")!.findAll((node) => node.type === IncognitoSpecs)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === SystemGlyph && node.props.systemName === "eyes")).toHaveLength(0);
  expect(root.root.findAll((node) => node.props.testID === "deckBarIncognito" && node.props.incognito === true)).toHaveLength(0);
  expect(host(root, "deckBarIncognitoOn")).toBeUndefined();
  unmount(root);
  expect(designFor("android")).toBe("redesigned");
  const original = deck("original");
  expect(incognitoSwitch(original)).toBeUndefined();
  expect(host(original, "deckBarIncognito")).toBeUndefined();
  unmount(original);
});

test("a tap on the switch shows only the Incognito tabs, fills the whole switch and closes its eyes, the plus makes Incognito tabs, and a second tap brings the normal deck back; only the switch to Incognito is counted", () => {
  withPrivateTabs(2);
  const root = deck();
  expect(hosts(root, "deckCard")).toHaveLength(9);
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => jest.advanceTimersByTime(600));
  expect(useTabs.getState().incognito).toBe(true);
  expect(hosts(root, "deckCard")).toHaveLength(2);
  expect(incognitoSwitch(root)!.props.accessibilityState).toMatchObject({ checked: true });
  expect(incognitoSwitch(root)!.props.accessibilityHint).toBe("Shows your tabs.");
  expect(root.root.findAll((node) => node.props.testID === "deckBarIncognito" && node.props.incognito === true).length).toBeGreaterThan(0);
  expect(StyleSheet.flatten(host(root, "deckBarIncognitoOn")!.props.style)).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(host(root, "deckBarIncognitoGlyph")!.findAll((node) => node.type === Symbol && node.props.name === "eyesClosed")).toHaveLength(1);
  expect(pressable(root, "New Incognito Tab")).toBeDefined();
  expect(counted.mock.calls.filter(([name]) => name === "deck_incognito_switches")).toHaveLength(1);
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => jest.advanceTimersByTime(600));
  expect(useTabs.getState().incognito).toBe(false);
  expect(hosts(root, "deckCard")).toHaveLength(9);
  expect(counted.mock.calls.filter(([name]) => name === "deck_incognito_switches")).toHaveLength(1);
  unmount(root);
});

test("the switch fades the shown side's cards out before the other side's cards take their place, and a second tap during the fade keeps the side", () => {
  withPrivateTabs(2);
  const root = deck();
  act(() => incognitoSwitch(root)!.props.onPress());
  expect(incognitoSwitch(root)!.props.accessibilityState).toMatchObject({ checked: true });
  expect(hosts(root, "deckCard")).toHaveLength(9);
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(2);
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => jest.advanceTimersByTime(600));
  expect(useTabs.getState().incognito).toBe(true);
  expect(hosts(root, "deckCard")).toHaveLength(2);
  unmount(root);
});

test("with no Incognito tabs the switch shows an empty Incognito deck that says so, without the Archive link or the Archive capsule, and switching back shows every normal tab", () => {
  act(() => useArchiveCard.setState({ showing: true }));
  const root = deck();
  expect(host(root, "archiveCapsule")).toBeDefined();
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(0);
  expect(host(root, "archiveCapsule")).toBeUndefined();
  expect(textOf(root)).toContain("No Incognito Tabs");
  expect(textOf(root)).toContain("Incognito tabs aren’t saved to your history or the Archive.");
  expect(textOf(root)).not.toContain("Open Archive");
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(9);
  expect(textOf(root)).not.toContain("No Incognito Tabs");
  expect(host(root, "archiveCapsule")).toBeDefined();
  unmount(root);
});

test("closing the last Incognito card from the deck keeps the empty Incognito side, as Safari's Private does", () => {
  withPrivateTabs(1);
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation((id) => useTabs.setState((state) => ({ ...state, privates: state.privates.filter((tab) => tab.id !== id), incognito: false })));
  const root = deck();
  act(() => incognitoSwitch(root)!.props.onPress());
  act(() => jest.advanceTimersByTime(600));
  const closes = (action: { name: string; label?: string }) => action.name === "Close Tab" || action.label === "Close Tab";
  const card = root.root.findAll((node) => typeof node.props.onAccessibilityAction === "function" && node.props.accessibilityActions?.some(closes))[0]!;
  const action = card.props.accessibilityActions.find(closes);
  act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: action.name } }));
  act(() => jest.advanceTimersByTime(1500));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(useTabs.getState().privates).toHaveLength(0);
  expect(useTabs.getState().incognito).toBe(true);
  expect(textOf(root)).toContain("No Incognito Tabs");
  unmount(root);
});

test("the original deck keeps its private tabs among the others, as before the switch", () => {
  withPrivateTabs(2);
  const root = deck("original");
  expect(hosts(root, "deckCard")).toHaveLength(11);
  act(() => useTabs.setState({ incognito: true }));
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(11);
  unmount(root);
});

test("the plus opens a tab, and holding it offers a private tab and reopening without Close All, which lives in the ··· menu", () => {
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const opened = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const root = deck();
  const plus = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onLongPress === "function")[0]!;
  act(() => plus.props.onPress());
  expect(opened).toHaveBeenCalledTimes(1);
  act(() => plus.props.onLongPress());
  expect(menuLabels(root)).toEqual(["New Incognito Tab", "Reopen Closed Tab"]);
  unmount(root);
});

test("Search Tabs filters the deck to the tabs whose title or address match, says No Matching Tabs when none do, and clearing brings every tab back", () => {
  const root = deck();
  expect(hosts(root, "deckCard")).toHaveLength(9);
  search(root, "Site 3");
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(1);
  expect(style(root, "deckSearchTabs").paddingRight).toBe(8);
  search(root, "site5.example");
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(1);
  search(root, "nothing like it");
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(0);
  expect(textOf(root)).toContain("No Matching Tabs");
  expect(textOf(root)).not.toContain("No Open Tabs");
  act(() => pressable(root, "Clear Search").props.onPress());
  act(() => jest.advanceTimersByTime(600));
  expect(hosts(root, "deckCard")).toHaveLength(9);
  expect(host(root, "deckSearchClear")).toBeUndefined();
  unmount(root);
});

test("opening Search Tabs counts search_tabs_opened once per focus, and never while browsing privately", () => {
  const root = deck();
  act(() => searchField(root).props.onFocus());
  expect(counted).toHaveBeenCalledWith("search_tabs_opened");
  expect(counted.mock.calls.filter(([field]) => field === "search_tabs_opened")).toHaveLength(1);
  unmount(root);
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  const privately = deck();
  act(() => searchField(privately).props.onFocus());
  expect(counted).not.toHaveBeenCalledWith("search_tabs_opened");
  unmount(privately);
});

test("the redesign's Archive card is main's slim capsule, 43 points tall, centred 78.5 under the safe top and 24 in from the sides like the header; the cards move 26 points down while it shows, and its x dismisses it", () => {
  act(() => useArchiveCard.setState({ showing: true }));
  const root = deck();
  expect(host(root, "archiveCardPlace")).toBeUndefined();
  const place = style(root, "archiveCapsulePlace");
  expect(place.top + 43 / 2).toBe(SAFE_TOP + 78.5);
  expect(place.paddingHorizontal).toBe(24);
  expect(style(root, "archiveCapsule")).toMatchObject({ minHeight: 43, borderRadius: 21.5, maxWidth: 560 });
  act(() => jest.advanceTimersByTime(1000));
  const shift = () => (getAnimatedStyle(host(root, "deckCards")!).transform as { translateY?: number }[]).find((step) => step.translateY !== undefined)!.translateY;
  expect(shift()).toBeCloseTo(26, 1);
  act(() => pressable(root, "Dismiss").props.onPress());
  expect(useArchiveCard.getState().showing).toBe(false);
  act(() => jest.advanceTimersByTime(1000));
  expect(host(root, "archiveCapsule")).toBeUndefined();
  expect(shift()).toBeCloseTo(0, 1);
  unmount(root);
});

test("on iPhone the Search Tabs placeholder is the system's placeholder tone (label at 30%) as main's TextField draws it; Android keeps its secondary tone", () => {
  const root = deck();
  const placeholder = searchField(root).props.placeholderTextColor;
  if (Platform.OS === "ios") expect(placeholder).toBe("rgba(60,60,67,0.3)");
  else expect(placeholder).not.toBe("rgba(60,60,67,0.3)");
  unmount(root);
});
