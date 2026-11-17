import { Platform } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { PagerNeighbour } from "../components/browsing/TabPager";
import { DeckCard } from "../components/tabs/DeckCard";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import { deckCardAt, deckGeometry, initialDeckScroll } from "../lib/deckGeometry";
import type { Design } from "../lib/design";
import { haptics } from "../state/app/haptics";
import { useArchiveCard } from "../state/browse/archiveCard";
import * as browse from "../state/browse/store";
import { dismissSearch, presentSearch, setSearchText, useSearch } from "../state/search/store";
import * as syncActions from "../state/sync/actions";
import * as syncStore from "../state/sync/store";
import { OFF_STATUS, setSpacesDesign, useSync, type SyncedProfile } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useSelectedTab } from "../state/tabs/hooks";
import { currentTabs, openNewTab, useTabs } from "../state/tabs/store";
import { deckOrder, launchTabs } from "../state/tabs/tabsState";
import { readOpenTabs } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";

const profile = (syncId: string, name: string, isDefault = false): SyncedProfile => ({
  syncId,
  name,
  color: null,
  icon: null,
  isDefault,
  theme: null,
  deviceTabs: [],
  pinned: { tiles: [], sections: [] },
  bookmarks: [],
  history: [],
  sendTargets: null,
});

const PROFILES = [profile("personal", "Personal", true), profile("work", "Work")];

const SPACES: (string | null)[] = [null, "personal", "work", "work", "deleted-on-the-mac"];
const PERSONAL = ["t0", "t1", "t4"];
const WORK = ["t2", "t3"];
const EVERY = ["t0", "t1", "t2", "t3", "t4"];

function showSpace(id: string | null) {
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated", selectedProfileId: id },
    view: { devices: [], profiles: PROFILES, search: null, syncedAt: 1, selectedProfileId: id, shownProfileId: id, receivers: [] },
  }));
}

const switchTo = (id: string) => act(() => showSpace(id));

function setUp(design: Design, space = "work") {
  const tabs = someTabs(SPACES.length).map((tab, i) => ({ ...tab, profileSyncId: SPACES[i]! }));
  act(() => {
    useTabs.setState({ ...launchTabs(tabs, 0), incognito: false, listing: 0 });
    setSpacesDesign(design);
    showSpace(space);
  });
}

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  useArchiveCard.setState({ showing: false });
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  jest.spyOn(syncActions, "selectProfile").mockImplementation((id) => showSpace(id));
  jest.spyOn(syncStore, "showSpace").mockImplementation((id) => showSpace(id));
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => useArchiveCard.setState({ showing: false }));
  act(() => jest.runOnlyPendingTimers());
  setSpacesDesign("original");
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const deck = (design: Design) =>
  renderSurface(
    <DesignProvider design={design}>
      <TabDeck />
    </DesignProvider>,
  );

const cards = (root: Root) =>
  root.root
    .findAll((node) => node.type === DeckCard)
    .sort((a, b) => a.props.index - b.props.index)
    .map((node) => node.props.tab.id as string);
const sorted = (ids: readonly string[]) => [...ids].sort();
const menuLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const pickMenu = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
const pressable = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!;

function holdCard(root: Root, design: Design, id: string) {
  const order = cards(root);
  const index = order.indexOf(id);
  const g = deckGeometry(393, 873, 40, 24, 0, Platform.OS, design, deckHeaderBottom());
  const y = g.cardCenterY;
  let x = 0;
  while (x < 393 && deckCardAt(g, order.length, initialDeckScroll(order.length), x, y) !== index) x += 2;
  expect(x).toBeLessThan(393);
  act(() =>
    fireGestureHandler(getByGestureTestId("deckLongPress"), [
      { state: State.BEGAN, x, y, absoluteX: x, absoluteY: y },
      { state: State.ACTIVE, x, y, absoluteX: x, absoluteY: y },
      { state: State.END, x, y, absoluteX: x, absoluteY: y },
    ]),
  );
  act(() => jest.advanceTimersByTime(16));
}

function SelectedPage() {
  const tab = useSelectedTab();
  return tab ? <BrowsingScreen tab={tab} /> : null;
}

const page = (design: Design) =>
  renderSurface(
    <DesignProvider design={design}>
      <SelectedPage />
    </DesignProvider>,
  );

const neighbours = (root: Root) => root.root.findAll((node) => node.type === PagerNeighbour).map((node) => node.props.tab.id as string);

function switchToTabRows(text: string): string[] {
  act(() => presentSearch("page"));
  act(() => setSearchText(text));
  return useSearch
    .getState()
    .rows.flatMap((row) => (row.kind === "page" && row.tabId ? [row.tabId] : []));
}

test("the redesigned deck shows only the current space's tabs, counting a tab with no space or a gone space as the default's; the original shows every tab", () => {
  setUp("redesigned");
  const work = deck("redesigned");
  expect(sorted(cards(work))).toEqual(WORK);
  unmount(work);
  act(() => showSpace("personal"));
  const personal = deck("redesigned");
  expect(sorted(cards(personal))).toEqual(PERSONAL);
  unmount(personal);
  setUp("original");
  const original = deck("original");
  expect(sorted(cards(original))).toEqual(EVERY);
  unmount(original);
});

test("picking another space in the deck's switcher shows that space's tabs and counts the pick, never while browsing privately", () => {
  setUp("redesigned");
  const root = deck("redesigned");
  act(() => pressable(root, "Space, Work").props.onPress());
  expect(menuLabels(root)).toEqual(["Personal", "Work"]);
  pickMenu(root, "Personal");
  act(() => jest.advanceTimersByTime(400));
  expect(sorted(cards(root))).toEqual(PERSONAL);
  expect(counted).toHaveBeenCalledWith("spaces_picked");
  expect(PERSONAL).toContain(currentTabs().selectedId);
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  act(() => pressable(root, "Space, Personal").props.onPress());
  pickMenu(root, "Work");
  act(() => jest.advanceTimersByTime(400));
  expect(sorted(cards(root))).toEqual(WORK);
  expect(counted).not.toHaveBeenCalledWith("spaces_picked");
  unmount(root);
});

test("switching space selects that space's most recent tab, or nothing so the start page shows", () => {
  setUp("redesigned");
  expect(currentTabs().selectedId).toBe("t3");
  switchTo("personal");
  expect(currentTabs().selectedId).toBe("t4");
  useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.profileSyncId !== "work") }));
  switchTo("work");
  expect(currentTabs().selectedId).toBeNull();
});

test("the tab swipe's neighbours are the current space's tabs in the redesign, and every tab in the original", () => {
  setUp("redesigned");
  const work = page("redesigned");
  expect(neighbours(work)).toEqual(["t2"]);
  expect(browse.swipeOrder()).toEqual(["t2", "t3"]);
  switchTo("personal");
  expect(sorted(browse.swipeOrder())).toEqual(PERSONAL);
  expect(neighbours(work)).toEqual(["t1"]);
  unmount(work);
  setUp("original");
  const original = page("original");
  expect(neighbours(original)).toEqual(["t3"]);
  expect(browse.swipeOrder()).toEqual(EVERY);
  unmount(original);
});

test("Switch to Tab offers only the current space's tabs in the redesign, and every tab in the original", () => {
  setUp("redesigned");
  expect(switchToTabRows("site0.example")).toEqual([]);
  expect(switchToTabRows("site2.example")).toEqual(["t2"]);
  act(() => dismissSearch());
  switchTo("personal");
  expect(switchToTabRows("site0.example")).toEqual(["t0"]);
  expect(switchToTabRows("site2.example")).toEqual([]);
  act(() => dismissSearch());
  setUp("original");
  expect(switchToTabRows("site0.example")).toEqual(["t0"]);
  expect(switchToTabRows("site2.example")).toEqual(["t2"]);
});

test("Move to Space in a card's menu moves the tab to the space it picks: it leaves the deck, is saved there and counted", () => {
  setUp("redesigned");
  const root = deck("redesigned");
  holdCard(root, "redesigned", "t2");
  expect(menuLabels(root)).toEqual(["Copy Link", "Share", "Pin to Mac", "Move to Space", "Close Tab"]);
  pickMenu(root, "Move to Space");
  expect(menuLabels(root)).toEqual(["Personal"]);
  pickMenu(root, "Personal");
  act(() => jest.advanceTimersByTime(400));
  expect(cards(root)).toEqual(["t3"]);
  expect(readOpenTabs(browserDatabase()).find((tab) => tab.id === "t2")?.profileSyncId).toBe("personal");
  expect(counted).toHaveBeenCalledWith("tabs_moved_to_space");
  switchTo("personal");
  act(() => jest.advanceTimersByTime(400));
  expect(sorted(cards(root))).toEqual(sorted([...PERSONAL, "t2"]));
  unmount(root);
});

test("the original deck's card menu has no Move to Space, and a private tab's has none in the redesign", () => {
  setUp("original");
  const original = deck("original");
  holdCard(original, "original", "t2");
  expect(menuLabels(original)).not.toContain("Move to Space");
  unmount(original);
  setUp("redesigned");
  useTabs.setState((state) => ({ ...state, privates: someTabs(1, true) }));
  const root = deck("redesigned");
  holdCard(root, "redesigned", "p0");
  expect(menuLabels(root)).not.toContain("Move to Space");
  unmount(root);
});

test("a new tab lands in the current space, and in the redesign leaves the deck when the space changes", () => {
  setUp("redesigned");
  const tab = openNewTab({ url: "https://new.example/", origin: "typed" });
  expect(tab.profileSyncId).toBe("work");
  expect(deckOrder(currentTabs()).map((t) => t.id)).toContain(tab.id);
  switchTo("personal");
  expect(deckOrder(currentTabs()).map((t) => t.id)).not.toContain(tab.id);
  setUp("original", "personal");
  const kept = openNewTab({ url: "https://kept.example/", origin: "typed" });
  expect(kept.profileSyncId).toBe("personal");
  switchTo("work");
  expect(deckOrder(currentTabs()).map((t) => t.id)).toContain(kept.id);
});

test("opening a tab from another space, as Switch to Tab can, shows its space first; the original never switches", () => {
  setUp("redesigned");
  act(() => browse.openTab("t0"));
  expect(syncStore.showSpace).toHaveBeenCalledWith("personal");
  expect(currentTabs().selectedId).toBe("t0");
  expect(sorted(deckOrder(currentTabs()).map((t) => t.id))).toEqual(PERSONAL);
  (syncStore.showSpace as jest.Mock).mockClear();
  setUp("original");
  act(() => browse.openTab("t0"));
  expect(syncStore.showSpace).not.toHaveBeenCalled();
});
