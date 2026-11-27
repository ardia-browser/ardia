import { Dimensions, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { DuoBrowsing } from "../components/duo/DuoBrowsing";
import { useCommandBar, type CommandBarPlacement } from "../components/duo/CommandBar";
import { ConfirmSheet, controlRadius, DesignProvider, iconRoles, shadowCss, Symbol } from "../components/ui";
import { MenuTrigger } from "../components/ui/MenuTrigger";
import { setRootSize } from "../state/app/rootSize";
import { PHONE_LAYOUT, useScreenLayout, type ScreenLayout } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import { presentSearch, dismissSearch } from "../state/search/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as tabHooks from "../state/tabs/hooks";
import { useLibrary } from "../state/library/store";
import * as telemetry from "../state/telemetry/telemetry";
import { usePageUi } from "../state/page/store";
import { actionWords } from "../lib/sharedWords";
import { OFF_STATUS, useSync, type SyncedProfile } from "../state/sync/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockReaderRenders: { tabId: string; closing: boolean }[] = [];

jest.mock("../components/browsing/ReaderView", () => ({
  ...jest.requireActual("../components/browsing/ReaderView"),
  ReaderView: ({ tabId, closing = false }: { tabId: string; closing?: boolean }) => {
    mockReaderRenders.push({ tabId, closing });
    return null;
  },
}));

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const PORTRAIT_WINDOW = Dimensions.get("window");
const OPEN = { width: 669, height: 951, insets: { top: 59, bottom: 34, left: 0, right: 0 } };
const OPEN_SIDEWAYS = { width: 951, height: 669, insets: { top: 0, bottom: 21, left: 59, right: 59 } };

type Shape = typeof OPEN;

function useShape(shape: Shape, layout: ScreenLayout) {
  Dimensions.set({ window: { ...PORTRAIT_WINDOW, width: shape.width, height: shape.height }, screen: { ...PORTRAIT_WINDOW, width: shape.width, height: shape.height } });
  act(() => setRootSize(shape.width, shape.height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => shape.insets);
  act(() => useScreenLayout.setState({ layout }));
}

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  act(() => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, leaving: null }));
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useScreenLayout.setState({ layout: PHONE_LAYOUT }));
  act(() => setRootSize(0, 0));
  Dimensions.set({ window: PORTRAIT_WINDOW, screen: PORTRAIT_WINDOW });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const host = (root: Root, id: string) => hosts(root, id)[0]!;
const flat = (node: ReactTestInstance) => StyleSheet.flatten(typeof node.props.style === "function" ? node.props.style({ pressed: false }) : node.props.style) ?? {};
const frame = (root: Root, id: string) => {
  const { left, top, width, height } = flat(host(root, id));
  return { left, top, width, height };
};
const redesigned = () => renderSurface(<DesignProvider design="redesigned"><DuoBrowsing /></DesignProvider>);
const settle = () => act(() => jest.advanceTimersByTime(1000));
const sidebarShown = (root: Root) => hosts(root, "duoSidebarPlace").length > 0 && host(root, "duoSidebarPlace").props.pointerEvents !== "none";
const press = (node: ReactTestInstance) => act(() => node.props.onPress());
const button = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!;

test("an open Duo upright lays the page card at 11, 63, 647 by 874 with main's 16 corner and shadow, the toolbar 9 into it, and the page clears 63 at the top", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  expect(frame(root, "duoCard")).toEqual({ left: 11, top: 63, width: 647, height: 874 });
  expect(flat(host(root, "duoCard"))).toMatchObject({ borderRadius: 16, borderCurve: "continuous", boxShadow: "0px 2px 20px rgba(0,0,0,0.12)" });
  expect(frame(root, "duoToolbarPlace")).toEqual({ left: 11, top: 72, width: 647, height: 45 });
  const page = root.root.findAll((node) => node.props.testID === "duoPage" && "obscuredInsets" in node.props)[0]!;
  expect(page.props.topClearance).toBe(63);
  expect(page.props.obscuredInsets).toEqual({ top: 0, bottom: 0 });
  expect(hosts(root, "duoSidebarPlace")).toHaveLength(0);
  unmount(root);
});

test("an open Duo on its side pads the card and the sidebar by the side insets: card 70, 33, 811 by 627", () => {
  useShape(OPEN_SIDEWAYS, { name: "wide" });
  act(() => browse.useBrowse.setState({ surface: "deck" }));
  const root = redesigned();
  settle();
  expect(frame(root, "duoCard")).toEqual({ left: 70, top: 33, width: 811, height: 627 });
  expect(frame(root, "duoToolbarPlace")).toEqual({ left: 70, top: 42, width: 811, height: 45 });
  expect(frame(root, "duoSidebarPlace")).toEqual({ left: 70, top: 11, width: 260, height: 649 });
  unmount(root);
});

test("the toolbar has main's 45 circles, gap 7 and padding 8, and an address capsule 44 high with 8 leading, 20 trailing and a 30 by 44 sidebar button", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  expect(flat(host(root, "duoToolbar"))).toMatchObject({ gap: 7, paddingHorizontal: 8, height: 45 });
  expect(flat(host(root, "duoToolbar:Back"))).toMatchObject({ width: 45, height: 45 });
  expect(flat(host(root, "duoAddress"))).toMatchObject({ height: 44, gap: 10, paddingLeft: 8, paddingRight: 20 });
  expect(flat(button(root, "Show Sidebar"))).toMatchObject({ width: 30, height: 44 });
  for (const label of ["Back", "Forward", "Reload", "Share", "Page Menu"]) expect(hosts(root, `duoToolbar:${label}`)).toHaveLength(1);
  unmount(root);
});

test("entering wide with the deck up browses the selected tab and opens the sidebar: 260 wide at 11, 11, a 0.12 dim behind, the address capsule hidden", () => {
  useShape(OPEN, { name: "wide" });
  act(() => browse.useBrowse.setState({ surface: "deck", deckEntrance: currentTabs().selectedId, leaving: currentTabs().selectedId }));
  const root = redesigned();
  settle();
  expect(browse.useBrowse.getState()).toMatchObject({ surface: "browsing", deckEntrance: null, leaving: null });
  expect(sidebarShown(root)).toBe(true);
  expect(frame(root, "duoSidebarPlace")).toEqual({ left: 11, top: 11, width: 260, height: 926 });
  expect(flat(host(root, "duoSidebarFill"))).toMatchObject({ borderRadius: 16, boxShadow: shadowCss("floating", false) });
  expect(flat(host(root, "duoSidebarHeader"))).toMatchObject({ height: 50, marginTop: 25 });
  expect(host(root, "duoAddressSlot").props.pointerEvents).toBe("none");
  const dim = root.root.findAll((node) => node.props.accessibilityLabel === "Hide Sidebar" && typeof node.type === "string" && flat(node).backgroundColor === "rgba(0,0,0,0.12)");
  expect(dim).toHaveLength(1);
  unmount(root);
});

test("the sidebar lists the space's tabs on 46-point rows 41 high, the selected one in glass with a 44 by 41 close, then a New Tab row", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  press(button(root, "Show Sidebar"));
  settle();
  const ids = [...currentTabs().open.map((tab) => tab.id)];
  for (const id of ids) expect(hosts(root, `duoSidebarRow:${id}`)).toHaveLength(1);
  const selected = currentTabs().selectedId!;
  expect(flat(host(root, `duoSidebarRow:${selected}`))).toMatchObject({ height: 41, borderRadius: 11 });
  expect(hosts(root, "duoSidebarRowGlass")).toHaveLength(1);
  expect(flat(host(root, "duoSidebarRowClose"))).toMatchObject({ width: 44, height: 41 });
  expect(flat(host(root, "duoSidebarNewTab"))).toMatchObject({ height: 46, paddingLeft: 13, gap: 12 });
  unmount(root);
});

const triggerAround = (root: Root, testID: string) => root.root.findAll((node) => node.type === MenuTrigger && node.findAll((inner) => inner.props.testID === testID).length > 0)[0]!;
const menuWords = (trigger: ReactTestInstance) => (trigger.props.items as ("divider" | { label: string })[]).map((item) => (item === "divider" ? "—" : item.label));
const menuItem = (trigger: ReactTestInstance, label: string) => (trigger.props.items as ("divider" | { label: string; onPress: () => void; destructive?: boolean })[]).find((item) => item !== "divider" && item.label === label) as { onPress: () => void; destructive?: boolean };

test("the sidebar's More menu reads Archive, Spaces, then History, Bookmarks and Downloads, then Settings, with no tab actions, and its Library rows open their section and count it", () => {
  useShape(OPEN, { name: "wide" });
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  act(() => useSync.setState((state) => ({ ...state, status: { ...OFF_STATUS, isEnabled: true, phase: "updated" } })));
  const root = redesigned();
  press(button(root, "Show Sidebar"));
  settle();
  const more = triggerAround(root, "duoSidebarMore");
  expect(more.props.trigger).toBe("tap");
  expect(menuWords(more)).toEqual(["Archive", "Spaces", "—", "History", "Bookmarks", "Downloads", "—", "Settings"]);
  act(() => menuItem(more, "Bookmarks").onPress());
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "bookmarks" });
  expect(counted.mock.calls.map(([field]) => field)).toContain("deck_menu_bookmarks_opened");
  act(() => useLibrary.setState({ open: false }));
  act(() => useSync.setState((state) => ({ ...state, status: OFF_STATUS })));
  unmount(root);
});

test("holding the sidebar's New Tab offers a private tab, reopening and, set apart, Close All Tabs, which asks before it closes anything; a tap still opens a tab", () => {
  useShape(OPEN, { name: "wide" });
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const opened = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const incognito = jest.spyOn(browse, "newIncognitoTab").mockImplementation(() => undefined);
  const reopen = jest.spyOn(browse, "reopenLastClosed").mockImplementation(() => undefined);
  const closeAll = jest.spyOn(browse, "closeAllFromDeck").mockImplementation(() => undefined);
  const root = redesigned();
  press(button(root, "Show Sidebar"));
  settle();
  const plus = () => triggerAround(root, "duoSidebarNewTab");
  expect(plus().props.trigger).toBe("longPress");
  expect(menuWords(plus())).toEqual(["New Incognito Tab", "Reopen Closed Tab", "—", "Close All Tabs"]);
  expect(menuItem(plus(), "Close All Tabs").destructive).toBe(true);
  expect(root.root.findAll((node) => node.props.testID === "duoSidebarNewTab" && typeof node.props.onLongPress === "function" && node.props.hint === "Touch and hold for more options.")).toHaveLength(1);
  act(() => menuItem(plus(), "New Incognito Tab").onPress());
  act(() => menuItem(plus(), "Reopen Closed Tab").onPress());
  expect([incognito, reopen].map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
  act(() => menuItem(plus(), "Close All Tabs").onPress());
  expect(closeAll).not.toHaveBeenCalled();
  const sheet = root.root.findAll((node) => node.type === ConfirmSheet)[0]!;
  expect(sheet.props.confirmation).toMatchObject({ title: "Close 3 Tabs?", action: "Close All Tabs" });
  act(() => sheet.props.confirmation.run());
  expect(closeAll).toHaveBeenCalledTimes(1);
  press(root.root.findAll((node) => node.props.testID === "duoSidebarNewTab" && typeof node.props.onPress === "function")[0]!);
  expect(opened).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the wide toolbar's address is a pill like the browsing address, the sidebar keeps its own rounded field, and both sidebar buttons draw the shared sidebar symbol", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  expect(flat(host(root, "duoAddress"))).toMatchObject({ borderRadius: 22, borderCurve: "continuous" });
  expect(root.root.findAll((node) => node.props.testID === "duoAddress" && node.props.shape === "capsule").length).toBeGreaterThan(0);
  const sidebarSymbols = () => root.root.findAll((node) => node.type === Symbol && node.props.name === iconRoles.sidebar);
  expect(sidebarSymbols()).toHaveLength(1);
  press(button(root, "Show Sidebar"));
  settle();
  expect(flat(host(root, "duoSidebarAddress"))).toMatchObject({ height: 43, borderRadius: controlRadius(43), borderCurve: "continuous" });
  expect(root.root.findAll((node) => node.props.testID === "duoSidebarAddress" && node.props.shape === "rounded").length).toBeGreaterThan(0);
  expect(sidebarSymbols()).toHaveLength(2);
  const more = root.root.findAll((node) => node.props.testID === "duoSidebarMore" && typeof node.props.style === "function")[0]!;
  expect(StyleSheet.flatten(more.props.style({ pressed: true }))).toMatchObject({ opacity: 0.35 });
  unmount(root);
});

test("picking a tab in the sidebar browses it and hides the sidebar", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  press(button(root, "Show Sidebar"));
  settle();
  const other = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  const row = host(root, `duoSidebarRow:${other.id}`);
  act(() => row.findAll((node) => node.props.accessibilityRole === "button" && node.props.accessibilityLabel !== "Close Tab" && typeof node.props.onPress === "function")[0]!.props.onPress());
  settle();
  expect(currentTabs().selectedId).toBe(other.id);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(sidebarShown(root)).toBe(false);
  expect(hosts(root, "duoSidebarPlace")).toHaveLength(0);
  unmount(root);
});

test("starting a search hides the sidebar", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  press(button(root, "Show Sidebar"));
  settle();
  expect(sidebarShown(root)).toBe(true);
  act(() => presentSearch("page"));
  settle();
  expect(sidebarShown(root)).toBe(false);
  unmount(root);
});

test("with the deck up and no tab selected, the sidebar opens over an empty card, and hiding it goes to the start page", () => {
  useShape(OPEN, { name: "wide" });
  act(() => useTabs.setState({ selectedId: null }));
  act(() => browse.useBrowse.setState({ surface: "deck" }));
  const root = redesigned();
  settle();
  expect(sidebarShown(root)).toBe(true);
  expect(root.root.findAll((node) => node.props.testID === "duoPage")).toHaveLength(0);
  press(button(root, "Hide Sidebar"));
  settle();
  expect(browse.useBrowse.getState().surface).toBe("start");
  unmount(root);
});

test("half open, the card stops 11 over the fold, the toolbar drops the address, and the tabs sit below the fold as a panel from 16 with no tiles or sidebar button", () => {
  useShape(OPEN, { name: "split", fold: { top: 465.5, bottom: 485.5 } });
  act(() => browse.useBrowse.setState({ surface: "deck" }));
  const root = redesigned();
  settle();
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(frame(root, "duoCard")).toEqual({ left: 11, top: 63, width: 647, height: 391.5 });
  expect(hosts(root, "duoAddress")).toHaveLength(0);
  expect(frame(root, "duoPanelPlace")).toEqual({ left: 0, top: 485.5, width: 669, height: 465.5 });
  expect(flat(host(root, "duoPanelPlace")).paddingBottom).toBe(34);
  expect(flat(host(root, "duoSidebarHeader")).marginTop).toBe(16);
  expect(hosts(root, "duoSidebarFill")).toHaveLength(0);
  expect(hosts(root, "duoSidebarTiles")).toHaveLength(0);
  expect(hosts(root, "duoSidebarPlace")).toHaveLength(0);
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Hide Sidebar")).toHaveLength(0);
  unmount(root);
});

test("a fold change hides the open sidebar", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  press(button(root, "Show Sidebar"));
  settle();
  expect(sidebarShown(root)).toBe(true);
  act(() => useScreenLayout.setState({ layout: { name: "split", fold: { top: 465.5, bottom: 485.5 } } }));
  settle();
  act(() => useScreenLayout.setState({ layout: { name: "wide" } }));
  settle();
  expect(sidebarShown(root)).toBe(false);
  unmount(root);
});

test("search in wide is a command bar 127 under the card top, 35 in from each side, at most 484 high and 24 over the keyboard; elsewhere it is the tray", () => {
  let placed: CommandBarPlacement | null = null;
  function Probe({ lift }: { lift: number }) {
    placed = useCommandBar(lift);
    return null;
  }
  useShape(OPEN, { name: "wide" });
  let root = renderSurface(<Probe lift={336} />);
  expect(placed).toEqual({ top: 190, left: 35, width: 599, maxHeight: 401 });
  unmount(root);
  jest.restoreAllMocks();
  useShape(OPEN_SIDEWAYS, { name: "wide" });
  root = renderSurface(<Probe lift={21} />);
  expect(placed).toEqual({ top: 160, left: 94, width: 763, maxHeight: 464 });
  unmount(root);
  act(() => useScreenLayout.setState({ layout: { name: "split", fold: { top: 300, bottom: 320 } } }));
  root = renderSurface(<Probe lift={21} />);
  expect(placed).toBeNull();
  unmount(root);
});

test("the wide toolbar and the sidebar draw the browsing bar's own address face, and the page's progress line is the shared one pinned to the card's top", () => {
  const { AddressFace } = require("../components/browsing/AddressFace") as typeof import("../components/browsing/AddressFace");
  const { PageProgressLine } = require("../components/browsing/PageProgressLine") as typeof import("../components/browsing/PageProgressLine");
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  const faces = () => root.root.findAll((node) => node.type === AddressFace);
  expect(faces()).toHaveLength(1);
  expect(faces()[0]!.props.testIDPrefix).toBe("duo");
  const { barAddress } = require("../components/browsing/FloatingBar") as typeof import("../components/browsing/FloatingBar");
  const selected = currentTabs().open.find((tab) => tab.id === currentTabs().selectedId)!;
  expect(host(root, "duoHost").props.children).toBe(barAddress(selected).host);
  press(button(root, "Show Sidebar"));
  settle();
  expect(faces()).toHaveLength(2);
  const progress = root.root.findAll((node) => node.type === PageProgressLine);
  expect(progress).toHaveLength(1);
  expect(progress[0]!.props.top).toBe(0);
  unmount(root);
});

test("Duo passes Reader through the regular browser's closing render, so the outgoing copy is gated before it unmounts", () => {
  useShape(OPEN, { name: "wide" });
  const root = redesigned();
  const selected = currentTabs().selectedId!;
  mockReaderRenders.length = 0;
  act(() => usePageUi.setState({ readerTabId: selected }));
  expect(mockReaderRenders.at(-1)).toEqual({ tabId: selected, closing: false });
  act(() => usePageUi.setState({ readerTabId: null }));
  expect(mockReaderRenders.at(-1)).toEqual({ tabId: selected, closing: true });
  expect(mockReaderRenders.filter((render) => render.closing)).toHaveLength(1);
  unmount(root);
});

test("Duo's toolbar and sidebar plates take the tab's private state, as the browsing bar's do", () => {
  useShape(OPEN, { name: "wide" });
  const space: SyncedProfile = { syncId: "work", name: "Work", color: null, icon: null, isDefault: true, theme: null, deviceTabs: [], pinned: { tiles: [{ key: "k1", title: "Pin", url: "https://pin.example/", icon: null, folder: null }], sections: [] }, bookmarks: [], history: [], sendTargets: null };
  act(() => useSync.setState((state) => ({ ...state, status: { ...OFF_STATUS, isEnabled: true, phase: "updated" }, view: { devices: [], profiles: [space], search: null, syncedAt: 1, selectedProfileId: "work", shownProfileId: "work", receivers: [] } as never })));
  const privates = [{ ...currentTabs().open[0]!, id: "private-0", isPrivate: true }];
  act(() => useTabs.setState((state) => ({ ...state, privates, selectedId: "private-0", incognito: true })));
  const root = redesigned();
  const privatePlate = (id: string) => root.root.findAll((node) => node.props.testID === id && node.props.incognito === true).length > 0;
  expect(privatePlate("duoAddress")).toBe(true);
  expect(privatePlate("duoToolbar:Back")).toBe(true);
  expect(privatePlate("duoToolbar:Page Menu")).toBe(true);
  press(button(root, "Show Sidebar"));
  settle();
  expect(privatePlate("duoSidebarAddress")).toBe(true);
  expect(root.root.findAll((node) => node.props.testID === "duoSidebarTile").length).toBeGreaterThan(0);
  expect(privatePlate("duoSidebarTile")).toBe(true);
  unmount(root);
  act(() => useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } })));
  act(() => useTabs.setState((state) => ({ ...state, privates: [], selectedId: state.open[0]!.id, incognito: false })));
  const regular = redesigned();
  expect(regular.root.findAll((node) => node.props.testID === "duoAddress" && node.props.incognito === true)).toHaveLength(0);
  unmount(regular);
});

test("with no tab, Duo's address face is named New Tab and starts one, not a search with this page's address", () => {
  useShape(OPEN, { name: "wide" });
  act(() => useTabs.setState({ selectedId: null }));
  act(() => browse.useBrowse.setState({ surface: "start" }));
  const started = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const root = redesigned();
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Address")).toHaveLength(0);
  const face = button(root, actionWords.newTab);
  expect(face.props.accessibilityHint).toBeUndefined();
  expect(face.props.accessibilityRole).toBe("button");
  press(face);
  expect(started).toHaveBeenCalledTimes(1);
  expect(host(root, "duoHost").props.children).toBe(actionWords.newTab);
  unmount(root);
});
