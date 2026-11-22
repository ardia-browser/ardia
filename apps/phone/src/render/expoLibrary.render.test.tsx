import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { haptics } from "../state/app/haptics";
import * as browse from "../state/browse/store";
import * as tabMenus from "../state/browse/tabMenus";
import { downloads } from "../platform/downloads";
import * as library from "../state/library/store";
import * as settingsActions from "../state/settings/actions";
import { useLibrary } from "../state/library/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

type Root = ReturnType<typeof renderSurface>;
type Modifier = { $type: string; title?: string; prompt?: string };

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
const librarySheet = (root: Root) => hosts(root.root, (props) => props.testID === "expoLibrarySheet")[0]!;
const presented = (root: Root) => hosts(librarySheet(root), (props) => typeof props.isPresented === "boolean")[0]!;
const withModifier = (node: ReactTestInstance, has: (modifier: Modifier) => boolean) => hosts(node, (props) => Array.isArray(props.modifiers) && (props.modifiers as Modifier[]).some(has));
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));
const buttonAround = (node: ReactTestInstance) => {
  let button: ReactTestInstance | null = node;
  while (button && !(typeof button.type === "string" && (typeof button.props.onButtonPress === "function" || typeof button.props.onPress === "function"))) button = button.parent;
  return button!;
};
const texts = (node: ReactTestInstance) => hosts(node, (props) => typeof props.text === "string").map((inner) => inner.props.text as string);
const settle = async () => act(async () => void jest.advanceTimersByTime(600));
const placementOf = (node: ReactTestInstance) => {
  let item: ReactTestInstance | null = node;
  while (item && typeof item.props.placement !== "string") item = item.parent;
  return item?.props.placement as string | undefined;
};
const openAt = async (section: library.LibrarySection) => {
  await act(async () => library.openLibrary(section));
  await settle();
};

onIos("on iPhone History opens in the system's own sheet with main's title, search, Done in the confirmation slot as Archive and Settings have it, switcher and More menu, and counts the open", async () => {
  const count = jest.spyOn(telemetry, "countUsage");
  const root = renderSurface(<Surfaces />);
  expect(presented(root).props.isPresented).toBe(false);
  await openAt("history");
  expect(presented(root).props.isPresented).toBe(true);
  expect(count).toHaveBeenCalledWith("library_opened");
  expect(hosts(root.root, (props) => props.accessibilityViewIsModal === true)).toHaveLength(0);
  const sheet = librarySheet(root);
  expect(withModifier(sheet, (modifier) => modifier.$type === "navigationTitle" && modifier.title === "History")).not.toHaveLength(0);
  expect(withModifier(sheet, (modifier) => modifier.$type === "searchable" && modifier.prompt === "Search History")).not.toHaveLength(0);
  expect(hosts(sheet, (props) => props.label === "More")).toHaveLength(1);
  expect(hosts(sheet, (props) => props.label === "Clear Browsing Data")).toHaveLength(1);
  expect(hosts(sheet, (props) => props.label === "Delete All…")).toHaveLength(0);
  expect(placementOf(hosts(sheet, (props) => props.label === "Done")[0]!)).toBe("confirmationAction");
  const segments = withModifier(sheet, (modifier) => modifier.$type === "tag");
  expect(segments.map((segment) => segment.props.systemName)).toEqual(["clock", "book", "arrow.down.circle"]);
  expect(segments.map((segment) => (segment.props.modifiers as Modifier[]).find((modifier) => modifier.$type === "accessibilityLabel"))).toEqual([expect.objectContaining({ label: "History" }), expect.objectContaining({ label: "Bookmarks" }), expect.objectContaining({ label: "Downloads" })]);
  await press(hosts(sheet, (props) => props.label === "Done")[0]!);
  expect(useLibrary.getState().open).toBe(false);
  await settle();
  unmount(root);
});

onIos("History shows the shared loading state, main's empty view, then day sections of rows with host and time; a row opens its page with the open-row tick, swipe deletes it, and the menu copies with the link glyph, shares and deletes", async () => {
  const tick = jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  const opened = jest.spyOn(library, "openFromLibrary").mockImplementation(() => undefined);
  const removed = jest.spyOn(library, "deleteHistoryEntry").mockImplementation(() => undefined);
  const copied = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  const root = renderSurface(<Surfaces />);
  await openAt("history");
  expect(hosts(librarySheet(root), (props) => props.text === "Loading…")).toHaveLength(1);
  await act(async () => useLibrary.setState({ historyLoaded: true, history: [] }));
  expect(hosts(librarySheet(root), (props) => props.text === "Loading…")).toHaveLength(0);
  expect(hosts(librarySheet(root), (props) => props.title === "No History")).toHaveLength(1);
  expect(hosts(librarySheet(root), (props) => props.description === "Pages you visit here and on your Mac show up here.")).toHaveLength(1);
  await act(async () => useLibrary.setState({ history: [entry(0), entry(1, "otherDevice"), entry(2, "thisDevice", NOW - 86_400_000 * 1.5)] }));
  const sheet = librarySheet(root);
  const shown = texts(sheet);
  expect(shown).toContain("Today");
  expect(shown).toContain("Visited 0");
  expect(shown.some((text) => text.startsWith("site1.example · "))).toBe(true);
  expect(hosts(sheet, (props) => props.systemName === "laptopcomputer")).toHaveLength(1);
  await press(buttonAround(hosts(sheet, (props) => props.text === "Visited 1")[0]!));
  expect(opened).toHaveBeenCalledWith("https://site1.example/page", "Visited 1");
  expect(tick).toHaveBeenCalledTimes(1);
  const lists = hosts(sheet, (props) => typeof props.onDelete === "function");
  await act(async () => lists[0]!.props.onDelete({ nativeEvent: { indices: [0], revision: lists[0]!.props.revision } }));
  expect(removed).toHaveBeenCalledWith(expect.objectContaining({ url: "https://site0.example/page" }));
  const menuLabels = hosts(sheet, (props) => props.label === "Copy Link" || props.label === "Delete" || props.title === "Share").map((node) => (node.props.label ?? node.props.title) as string);
  expect(menuLabels.slice(0, 3)).toEqual(["Copy Link", "Share", "Delete"]);
  expect(hosts(sheet, (props) => props.label === "Copy Link").map((node) => node.props.systemImage)).toEqual(expect.arrayContaining(["link"]));
  expect(hosts(sheet, (props) => props.label === "Copy Link" && props.systemImage === "doc.on.doc")).toHaveLength(0);
  await press(hosts(sheet, (props) => props.label === "Copy Link")[0]!);
  expect(copied).toHaveBeenCalledWith("https://site0.example/page");
  await settle();
  unmount(root);
});

onIos("Bookmarks shows main's sections, folder rows that push a folder page, host subtitles and main's empty views with sync off and on", async () => {
  const root = renderSurface(<Surfaces />);
  await openAt("bookmarks");
  expect(hosts(librarySheet(root), (props) => props.title === "No Bookmarks" && props.description === "Sync with your Mac to see its bookmarks here.")).toHaveLength(1);
  await act(async () => withSyncedBookmarks([]));
  expect(hosts(librarySheet(root), (props) => props.title === "No Bookmarks" && props.description === "Bookmarks you save on your Mac show up here.")).toHaveLength(1);
  await act(async () =>
    withSyncedBookmarks([
      bookmark("b1", "News", "https://www.news.example/", "bar"),
      bookmark("f1", "Reading", null, "bar", [bookmark("b2", "Essay", "https://essay.example/a", null)]),
      bookmark("b3", "Docs", "https://docs.example/", "other"),
    ]),
  );
  const sheet = librarySheet(root);
  expect(withModifier(sheet, (modifier) => modifier.$type === "searchable" && modifier.prompt === "Search Bookmarks")).not.toHaveLength(0);
  const shown = texts(sheet);
  expect(shown.indexOf("Bookmarks Bar")).toBeLessThan(shown.indexOf("News"));
  expect(shown.indexOf("Reading")).toBeLessThan(shown.indexOf("Other Bookmarks"));
  expect(shown.indexOf("Other Bookmarks")).toBeLessThan(shown.indexOf("Docs"));
  expect(shown).toContain("news.example");
  const folder = hosts(sheet, (props) => props.value === "folder:f1")[0]!;
  expect(texts(folder)).toEqual(["Reading", "1"]);
  await act(async () => hosts(sheet, (props) => typeof props.onPathChange === "function")[0]!.props.onPathChange({ nativeEvent: { path: ["folder:f1"] } }));
  expect(useLibrary.getState().path).toEqual(["folder:f1"]);
  expect(withModifier(librarySheet(root), (modifier) => modifier.$type === "navigationTitle" && modifier.title === "Reading")).not.toHaveLength(0);
  expect(texts(librarySheet(root))).toContain("Essay");
  await settle();
  unmount(root);
});

onIos("Downloads has no search, shows the shared loading state, file rows with size and date, previews on tap, swipes to delete or share, and Delete All… asks main's question with the scope in its title", async () => {
  const preview = jest.spyOn(library, "previewDownload").mockImplementation(() => undefined);
  const remove = jest.spyOn(library, "deleteDownload").mockImplementation(() => undefined);
  const share = jest.spyOn(library, "shareDownload").mockImplementation(() => undefined);
  const removeAll = jest.spyOn(library, "deleteAllDownloads").mockImplementation(() => undefined);
  const root = renderSurface(<Surfaces />);
  await openAt("downloads");
  expect(hosts(librarySheet(root), (props) => props.text === "Loading…")).toHaveLength(1);
  await act(async () => useLibrary.setState({ filesLoaded: true, files: [] }));
  expect(hosts(librarySheet(root), (props) => props.title === "No Downloads" && props.description === "Files you download show up here.")).toHaveLength(1);
  expect(hosts(librarySheet(root), (props) => props.label === "Delete All…")[0]!.props.modifiers).toEqual(expect.arrayContaining([expect.objectContaining({ $type: "disabled", disabled: true })]));
  await act(async () => useLibrary.setState({ files: [file(0), file(1)] }));
  const sheet = librarySheet(root);
  expect(withModifier(sheet, (modifier) => modifier.$type === "navigationTitle" && modifier.title === "Downloads")).not.toHaveLength(0);
  expect(withModifier(sheet, (modifier) => modifier.$type === "searchable")).toHaveLength(0);
  expect(texts(sheet).some((text) => text.startsWith("1.2 MB · "))).toBe(true);
  expect(hosts(sheet, (props) => props.systemName === "doc.richtext")).toHaveLength(2);
  await press(buttonAround(hosts(sheet, (props) => props.text === "report-1.pdf")[0]!));
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ name: "report-1.pdf" }));
  const deletes = hosts(sheet, (props) => props.label === "Delete" && typeof (props.onButtonPress ?? props.onPress) === "function");
  await press(deletes[deletes.length - 1]!);
  expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "report-1.pdf" }));
  const shares = hosts(sheet, (props) => props.label === "Share" && typeof (props.onButtonPress ?? props.onPress) === "function");
  await press(shares[shares.length - 1]!);
  expect(share).toHaveBeenCalledWith(expect.objectContaining({ name: "report-1.pdf" }));
  expect(hosts(sheet, (props) => props.title === "Delete All Downloads?")).toHaveLength(1);
  await press(hosts(sheet, (props) => props.label === "Delete All")[0]!);
  expect(removeAll).toHaveBeenCalledTimes(1);
  await settle();
  unmount(root);
});

onIos("the switcher changes section, and Clear Browsing Data pushes the Settings page inside the Library", async () => {
  jest.spyOn(settingsActions, "websiteDataClearsByTime").mockReturnValue(true);
  const root = renderSurface(<Surfaces />);
  await openAt("history");
  const picker = hosts(librarySheet(root), (props) => typeof props.onSelectionChange === "function" && props.selection === "history")[0]!;
  await act(async () => void picker.props.onSelectionChange({ nativeEvent: { selection: "downloads" } }));
  expect(useLibrary.getState().section).toBe("downloads");
  expect(hosts(librarySheet(root), (props) => props.label === "Delete All…")).toHaveLength(1);
  await press(hosts(librarySheet(root), (props) => props.label === "Clear Browsing Data")[0]!);
  expect(useLibrary.getState().path).toEqual(["clearData"]);
  expect(withModifier(librarySheet(root), (modifier) => modifier.$type === "navigationTitle" && modifier.title === "Clear Browsing Data")).not.toHaveLength(0);
  await act(async () => void presented(root).props.onIsPresentedChange({ nativeEvent: { isPresented: false } }));
  expect(useLibrary.getState().open).toBe(false);
  await settle();
  unmount(root);
});

onAndroid("Android draws no Library sheet", async () => {
  const root = renderSurface(<Surfaces />);
  expect(hosts(root.root, (props) => props.testID === "expoLibrarySheet")).toHaveLength(0);
  unmount(root);
});

test("a download's Share opens the share sheet on both phones, not the file's viewer, which Android's open is", async () => {
  const shared = jest.spyOn(downloads, "share").mockResolvedValue(true);
  const opened = jest.spyOn(downloads, "open").mockResolvedValue(true);
  await act(async () => {
    library.shareDownload({ uri: "file:///Download/report-1.pdf", name: "report-1.pdf" } as never);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
  expect(shared).toHaveBeenCalledWith("file:///Download/report-1.pdf");
  expect(opened).not.toHaveBeenCalled();
});

onIos("a History search with no matches shows the shared No Results template, as Archive's does, with the query in its cue", async () => {
  const root = renderSurface(<Surfaces />);
  await openAt("history");
  await act(async () => useLibrary.setState({ historyLoaded: true, history: [entry(0)] }));
  const search = withModifier(librarySheet(root), (modifier) => modifier.$type === "searchable")[0]!;
  const listener = (search.props.modifiers as (Modifier & { eventListener?: (event: { text: string }) => void })[]).find((modifier) => modifier.$type === "searchable")!.eventListener!;
  await act(async () => listener({ text: "otters" }));
  const empty = hosts(librarySheet(root), (props) => props.title === "No Results")[0]!;
  expect(empty.props.systemImage).toBe("magnifyingglass");
  expect(empty.props.description).toBe("Check the spelling or try a new search for “otters”.");
  expect(hosts(librarySheet(root), (props) => typeof props.title === "string" && (props.title as string).startsWith("No Results for"))).toHaveLength(0);
  await settle();
  unmount(root);
});
