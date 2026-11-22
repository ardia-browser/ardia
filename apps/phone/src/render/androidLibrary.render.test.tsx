import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { LibraryView } from "../components/library/LibraryView";
import * as browse from "../state/browse/store";
import * as tabMenus from "../state/browse/tabMenus";
import { downloads } from "../platform/downloads";
import * as library from "../state/library/store";
import { useLibrary } from "../state/library/store";
import { handleSystemBack } from "../state/page/actions";
import { useSettingsNav } from "../state/settings/nav";
import * as settings from "../state/settings/actions";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { currentTabs, openNewTab } from "../state/tabs/store";
import { ConfirmSheet, FloatingMenu, type MenuItem } from "../components/ui";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

type Root = ReturnType<typeof renderSurface>;

const NOW = Date.now();
const entry = (index: number, source: "thisDevice" | "otherDevice" = "thisDevice", at = NOW - index * 60_000) => ({ url: `https://site${index}.example/page`, title: `Visited ${index}`, visitedAt: at, source });
const file = (index: number) => ({ name: `report-${index}.pdf`, uri: `file:///downloads/report-${index}.pdf`, size: 1_200_000 + index, modified: NOW - index * 3_600_000, kind: "pdf" as const });

type Bookmark = { key: string; title: string; url: string | null; added: number; root: string | null; children: Bookmark[] | null };
const bookmark = (key: string, title: string, url: string | null, root: string | null, children: Bookmark[] | null = null): Bookmark => ({ key, title, url, added: 0, root, children });

const withSyncedBookmarks = (bookmarks: Bookmark[]) =>
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "idle" } as never,
    view: {
      devices: [],
      profiles: [{ syncId: "work", name: "Work", color: null, icon: null, isDefault: true, theme: null, deviceTabs: [], pinned: { tiles: [], sections: [] }, bookmarks, history: [], sendTargets: null }],
      search: null,
      syncedAt: 1,
      selectedProfileId: "work",
      receivers: [],
    } as never,
  }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  useSettingsNav.setState({ open: false, stack: [], popping: false });
  useLibrary.setState({ open: false, section: "history", path: [], history: [], historyLoaded: false, files: [], filesLoaded: false });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  jest.spyOn(library, "loadHistory").mockImplementation(() => undefined);
  jest.spyOn(library, "loadDownloads").mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const hosts = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const view = (root: Root) => hosts(root.root, (props) => props.testID === "libraryView");
const section = (root: Root, id: library.LibrarySection) => root.root.findAll((node) => node.props.testID === `librarySection:${id}` && typeof node.props.onPress === "function")[0]!;
const drawnMenu = (root: Root): MenuItem[] => root.root.findAll((node) => node.type === FloatingMenu)[0]?.props.items ?? [];
const labels = (items: MenuItem[]) => items.map((item) => (item === "divider" ? item : "label" in item ? item.label : item.heading));
const settle = async () => act(async () => void jest.advanceTimersByTime(900));
const openAt = async (section: library.LibrarySection) => {
  await act(async () => library.openLibrary(section));
  await settle();
};
const labelled = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function");
const titled = (root: Root, title: string) =>
  root.root.findAll((node) => typeof node.props.onPress === "function" && node.findAll((inner) => typeof inner.type === "string" && inner.children.includes(title)).length > 0);
const pressTitled = async (root: Root, title: string) => act(async () => void titled(root, title).at(-1)!.props.onPress());
const longPressTitled = async (root: Root, title: string) => act(async () => void titled(root, title).find((node) => typeof node.props.onLongPress === "function")!.props.onLongPress({ nativeEvent: { pageX: 100, pageY: 200 } }));

onAndroid("on Android the Library opens in the drawn sheet with its title, Done, switcher and search, and Done closes it", async () => {
  const root = renderSurface(<Surfaces />);
  expect(view(root)).toHaveLength(0);
  await openAt("history");
  expect(view(root)).toHaveLength(1);
  expect(textOf(root)).toContain("History");
  const tabs = hosts(root.root, (props) => props.accessibilityRole === "tab" && typeof props.testID === "string" && (props.testID as string).startsWith("librarySection:"));
  expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual(["History", "Bookmarks", "Downloads"]);
  expect(tabs[0]!.props.accessibilityState).toEqual({ selected: true });
  expect(hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.placeholder).toBe("Search History");
  await act(async () => section(root, "downloads").props.onPress());
  expect(useLibrary.getState().section).toBe("downloads");
  expect(hosts(root.root, (props) => props.testID === "librarySearch")).toHaveLength(0);
  await act(async () => section(root, "bookmarks").props.onPress());
  expect(hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.placeholder).toBe("Search Bookmarks");
  await pressTitled(root, "Done");
  expect(useLibrary.getState().open).toBe(false);
  await settle();
  expect(view(root)).toHaveLength(0);
  unmount(root);
});

onAndroid("History lists day sections of rows with host and time; search narrows them, a row opens its page, and its menu copies, shares and deletes", async () => {
  const opened = jest.spyOn(library, "openFromLibrary").mockImplementation(() => undefined);
  const removed = jest.spyOn(library, "deleteHistoryEntry").mockImplementation(() => undefined);
  const copied = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  const shared = jest.spyOn(tabMenus, "shareUrl").mockImplementation(() => undefined);
  const root = renderSurface(<Surfaces />);
  await openAt("history");
  await act(async () => useLibrary.setState({ historyLoaded: true, history: [] }));
  expect(textOf(root)).toContain("No History");
  await act(async () => useLibrary.setState({ history: [entry(0), entry(1, "otherDevice"), entry(2, "thisDevice", NOW - 86_400_000 * 1.5)] }));
  const shown = textOf(root);
  expect(shown).toContain("Today");
  expect(shown).toContain("Visited 1");
  expect(shown).toContain("site0.example");
  await act(async () => hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.onChangeText("site1"));
  expect(textOf(root)).toContain("Visited 1");
  expect(textOf(root)).not.toContain("Visited 0");
  await act(async () => hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.onChangeText("nothing here"));
  expect(textOf(root)).toContain("No Results for “nothing here”");
  await act(async () => hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.onChangeText(""));
  await pressTitled(root, "Visited 0");
  expect(opened).toHaveBeenCalledWith("https://site0.example/page", "Visited 0");
  await longPressTitled(root, "Visited 1");
  await pressTitled(root, "Copy Link");
  expect(copied).toHaveBeenCalledWith("https://site1.example/page");
  await longPressTitled(root, "Visited 1");
  await pressTitled(root, "Share");
  expect(shared).toHaveBeenCalledWith("https://site1.example/page", "Visited 1");
  await longPressTitled(root, "Visited 1");
  await pressTitled(root, "Delete");
  expect(removed).toHaveBeenCalledWith(expect.objectContaining({ url: "https://site1.example/page" }));
  unmount(root);
});

onAndroid("Bookmarks show the bar and other sections, a folder opens on top, and system back leaves the folder and then the Library", async () => {
  const opened = jest.spyOn(library, "openFromLibrary").mockImplementation(() => undefined);
  withSyncedBookmarks([
    bookmark("b1", "Docs", "https://docs.example/", "bar"),
    bookmark("f1", "Reading", null, "bar", [bookmark("b2", "Long Read", "https://read.example/a", null)]),
    bookmark("b3", "Recipes", "https://food.example/", "other"),
  ]);
  const root = renderSurface(<Surfaces />);
  await openAt("bookmarks");
  const shown = textOf(root);
  expect(shown).toContain("Bookmarks Bar");
  expect(shown).toContain("Other Bookmarks");
  expect(shown).toContain("Reading");
  await act(async () => hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.onChangeText("long"));
  expect(textOf(root)).toContain("Long Read");
  expect(textOf(root)).not.toContain("Recipes");
  await act(async () => hosts(root.root, (props) => props.testID === "librarySearch")[0]!.props.onChangeText(""));
  await pressTitled(root, "Reading");
  expect(useLibrary.getState().path).toEqual(["folder:f1"]);
  expect(textOf(root)).toContain("Long Read");
  expect(hosts(root.root, (props) => props.testID === "librarySwitcher")).toHaveLength(0);
  await pressTitled(root, "Long Read");
  expect(opened).toHaveBeenCalledWith("https://read.example/a", "Long Read");
  act(() => void handleSystemBack());
  expect(useLibrary.getState()).toMatchObject({ open: true, path: [] });
  act(() => void handleSystemBack());
  expect(useLibrary.getState().open).toBe(false);
  unmount(root);
});

onAndroid("Downloads list files with size and date; a file opens its viewer, and its menu shares or deletes it through the native downloads", async () => {
  const previewed = jest.spyOn(downloads, "preview").mockResolvedValue(true);
  const shared = jest.spyOn(downloads, "share").mockResolvedValue(true);
  const deleted = jest.spyOn(downloads, "delete").mockResolvedValue(true);
  const root = renderSurface(<Surfaces />);
  await openAt("downloads");
  await act(async () => useLibrary.setState({ filesLoaded: true, files: [] }));
  expect(textOf(root)).toContain("No Downloads");
  await act(async () => useLibrary.setState({ files: [file(0), file(1)] }));
  expect(textOf(root)).toContain("report-0.pdf");
  expect(textOf(root)).toMatch(/1\.2 MB · /);
  await pressTitled(root, "report-0.pdf");
  expect(previewed).toHaveBeenCalledWith("file:///downloads/report-0.pdf");
  await longPressTitled(root, "report-1.pdf");
  await pressTitled(root, "Share");
  expect(shared).toHaveBeenCalledWith("file:///downloads/report-1.pdf");
  await longPressTitled(root, "report-1.pdf");
  await pressTitled(root, "Delete");
  expect(deleted).toHaveBeenCalledWith("file:///downloads/report-1.pdf");
  expect(useLibrary.getState().files.map((shown) => shown.name)).toEqual(["report-0.pdf"]);
  unmount(root);
});

onAndroid("a Library link opened from Incognito stays private and never adds a regular tab", async () => {
  act(() => browse.openTab(openNewTab({ url: "https://example.com/", origin: "typed", isPrivate: true }).id));
  const normalTabs = currentTabs().open;
  await openAt("history");
  expect(browse.pageCovered()).toBe(true);
  act(() => library.openFromLibrary("https://private.example/story", "Private story"));
  const tabs = currentTabs();
  expect(tabs.open).toEqual(normalTabs);
  expect(tabs.privates.find((tab) => tab.id === tabs.selectedId)).toMatchObject({ isPrivate: true, url: "https://private.example/story" });
  expect(useLibrary.getState().open).toBe(false);
});

onAndroid("More opens Clear Browsing Data inside the Library, and Back and clearing both return to the current section", async () => {
  const remove = jest.spyOn(settings, "clearBrowsingData").mockResolvedValue(undefined);
  jest.spyOn(settings, "websiteDataClearsByTime").mockReturnValue(false);
  await openAt("history");
  const root = renderSurface(<LibraryView />);
  const openClearData = async () => {
    await act(async () => void labelled(root, "More")[0]!.props.onPress());
    expect(labels(drawnMenu(root))).toEqual(["Clear Browsing Data"]);
    await pressTitled(root, "Clear Browsing Data");
    expect(useLibrary.getState()).toMatchObject({ open: true, section: "history", path: [library.LIBRARY_CLEAR_DATA] });
  };
  await openClearData();
  act(() => void handleSystemBack());
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "history", path: [] });
  await openClearData();
  await pressTitled(root, "Clear Data…");
  await act(async () => root.root.findAll((node) => node.type === ConfirmSheet)[0]!.props.confirmation.run());
  expect(remove).toHaveBeenCalledTimes(1);
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "history", path: [] });
  expect(useSettingsNav.getState().open).toBe(false);
  unmount(root);
});

onAndroid("More offers Delete All Downloads… only on Downloads and asks before deleting files", async () => {
  const cleared = jest.spyOn(downloads, "deleteAll").mockResolvedValue(1);
  await openAt("downloads");
  const again = renderSurface(<LibraryView />);
  await act(async () => useLibrary.setState({ filesLoaded: true, files: [file(0)] }));
  await act(async () => void labelled(again, "More")[0]!.props.onPress());
  expect(labels(drawnMenu(again))).toEqual(["Delete All Downloads…", "divider", "Clear Browsing Data"]);
  await act(async () => (drawnMenu(again)[0] as { onPress: () => void }).onPress());
  expect(again.root.findAll((node) => node.type === ConfirmSheet)[0]!.props.confirmation).toMatchObject({ title: "Delete All Downloads?", action: "Delete All" });
  await act(async () => void again.root.findAll((node) => node.props.accessibilityLabel === "Delete All" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(cleared).toHaveBeenCalledTimes(1);
  expect(useLibrary.getState().files).toEqual([]);
  unmount(again);
});
