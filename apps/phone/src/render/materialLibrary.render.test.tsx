import { Platform, StyleSheet, Text } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import { act, type ReactTestInstance } from "react-test-renderer";
import { predictiveBack } from "@ardia/phone-native";
import { Surfaces } from "../App";
import { libraryBackStep, MaterialLibrary, materialLibraryMs } from "../components/library/MaterialLibrary";
import { DesignProvider, FloatingMenu } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import * as library from "../state/library/store";
import { openLibrary, useLibrary } from "../state/library/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, textOf, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;
const DAY = 86_400_000;
const NOW = Date.now();

type Handlers = Parameters<typeof predictiveBack.claim>[0];
let claimed: Handlers[] = [];

const entry = (index: number, at: number) => ({ url: `https://site${index}.example/page`, title: `Visited ${index}`, visitedAt: at, source: "thisDevice" as const });
const file = (index: number) => ({ name: `report-${index}.pdf`, uri: `file:///downloads/report-${index}.pdf`, size: 1_200_000, modified: NOW - index * 3_600_000, kind: "pdf" as const });

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
  claimed = [];
  withTabs(2);
  setDynamicScheme(null);
  act(() => {
    browse.useBrowse.setState({ surface: "browsing", sheet: null });
    useLibrary.setState({ open: false, section: "history", path: [], history: [], historyLoaded: false, files: [], filesLoaded: false });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  });
  jest.spyOn(library, "loadHistory").mockImplementation(() => useLibrary.setState({ historyLoaded: true }));
  jest.spyOn(library, "loadDownloads").mockImplementation(async () => useLibrary.setState({ filesLoaded: true }));
  jest.spyOn(predictiveBack, "claim").mockImplementation((handlers) => {
    claimed.push(handlers);
    return { remove: () => (claimed = claimed.filter((held) => held !== handlers)) };
  });
});

afterEach(() => {
  act(() => useLibrary.setState({ open: false }));
  act(() => jest.runOnlyPendingTimers());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const nodes = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string");
const pressables = (root: Root, id: string) => root.root.findAll((found) => found.type === Pressable && found.props.testID === id && typeof found.props.onPress === "function" && found.props.android_ripple !== undefined);
const pressable = (root: Root, id: string) => pressables(root, id)[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};
const textNode = (within: ReactTestInstance, text: string) => within.findAll((found) => found.type === Text && found.props.children === text)[0];

const libraryAlone = () =>
  renderSurface(
    <DesignProvider design="material">
      <MaterialLibrary />
    </DesignProvider>,
  );

const openAt = (section: library.LibrarySection) => act(() => openLibrary(section));

onAndroid("openLibrary brings up the Material library from the app's surfaces: a full-screen surface with a 64 dp top app bar, 48 dp icon buttons and 48 dp primary tabs", () => {
  const root = renderSurface(
    <DesignProvider design="material">
      <Surfaces />
    </DesignProvider>,
  );
  expect(node(root, "materialLibrary")).toBeUndefined();
  openAt("history");
  expect(flat(node(root, "materialLibrary")).backgroundColor).toBe(LIGHT.surface);
  expect(flat(node(root, "materialLibraryBar"))).toMatchObject({ height: 64, backgroundColor: LIGHT.surface });
  expect(flat(node(root, "materialLibraryTitle"))).toMatchObject({ fontSize: 22, lineHeight: 28, color: LIGHT.onSurface });
  expect(textOf(root)).toContain("History");
  for (const id of ["materialLibraryBack", "materialLibrarySearch"]) {
    expect(flat(node(root, id))).toMatchObject({ width: 48, height: 48 });
    expect(pressable(root, id).props.android_ripple).toMatchObject({ borderless: true });
  }
  expect(flat(node(root, "materialLibraryTabs"))).toMatchObject({ height: 48, backgroundColor: LIGHT.surface });
  unmount(root);
});

onAndroid("the active tab is labelled in primary over a 3 dp primary indicator with rounded top corners, the others in onSurfaceVariant, and a tab switches the section", () => {
  openAt("history");
  const root = libraryAlone();
  const tabs = node(root, "materialLibraryTabs")!;
  expect(flat(textNode(tabs, "History"))).toMatchObject({ fontSize: 14, fontWeight: "500", color: LIGHT.primary });
  expect(flat(textNode(tabs, "Bookmarks")).color).toBe(LIGHT.onSurfaceVariant);
  expect(flat(textNode(tabs, "Downloads")).color).toBe(LIGHT.onSurfaceVariant);
  expect(nodes(root, "materialLibraryIndicator")).toHaveLength(1);
  expect(flat(node(root, "materialLibraryIndicator"))).toMatchObject({ height: 3, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: LIGHT.primary });
  expect(pressable(root, "materialLibraryTab-history").props.accessibilityState).toEqual({ selected: true });
  act(() => {
    pressable(root, "materialLibraryTab-bookmarks").props.onPress();
  });
  expect(useLibrary.getState().section).toBe("bookmarks");
  expect(flat(textNode(node(root, "materialLibraryTabs")!, "Bookmarks")).color).toBe(LIGHT.primary);
  expect(textOf(root)).toContain("No Bookmarks");
  act(() => {
    pressable(root, "materialLibraryTab-downloads").props.onPress();
  });
  expect(useLibrary.getState().section).toBe("downloads");
  expect(node(root, "materialLibrarySearch")).toBeUndefined();
  expect(node(root, "materialLibraryMore")).toBeDefined();
  expect(textOf(root)).toContain("No Downloads");
  act(() => {
    pressable(root, "materialLibraryMore").props.onPress({ nativeEvent: { pageX: 0, pageY: 0, locationX: 0, locationY: 0 }, currentTarget: null });
  });
  const menu = root.root.findAll((inner) => inner.type === FloatingMenu)[0]!;
  expect((menu.props.items as { label?: string }[]).map((item) => item.label)).toEqual(["Delete All…"]);
  unmount(root);
});

onAndroid("history lists each day under a titleSmall primary header, as 72 dp two-line items, and a tap opens the page", () => {
  const opened = jest.spyOn(library, "openFromLibrary").mockImplementation(() => undefined);
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  jest.setSystemTime(noon);
  const yesterday = new Date(noon);
  yesterday.setDate(noon.getDate() - 1);
  act(() => useLibrary.setState({ history: [entry(1, noon.getTime()), entry(2, noon.getTime() - 60_000), entry(3, yesterday.getTime())], historyLoaded: true }));
  openAt("history");
  const root = libraryAlone();
  const headers = nodes(root, "materialLibraryHeader");
  expect(headers).toHaveLength(2);
  expect(flat(textNode(headers[0]!, "Today"))).toMatchObject({ fontSize: 14, color: LIGHT.primary });
  expect(textNode(headers[1]!, "Yesterday")).toBeDefined();
  const rows = pressables(root, "materialLibraryHistoryRow");
  expect(rows).toHaveLength(3);
  expect(flat(rows[0])).toMatchObject({ minHeight: 72, paddingHorizontal: 16 });
  expect(rows[0]!.props.android_ripple).toMatchObject({ borderless: false });
  expect(flat(textNode(rows[0]!, "Visited 1"))).toMatchObject({ fontSize: 16, color: LIGHT.onSurface });
  act(() => {
    rows[1]!.props.onPress();
  });
  expect(opened).toHaveBeenCalledWith("https://site2.example/page", "Visited 2");
  unmount(root);
});

onAndroid("the search button turns the bar into a field that filters history, and Back ends the search before it closes the library", () => {
  act(() => useLibrary.setState({ history: [entry(1, NOW), entry(2, NOW - 60_000)], historyLoaded: true }));
  openAt("history");
  const root = libraryAlone();
  act(() => {
    pressable(root, "materialLibrarySearch").props.onPress();
  });
  const field = root.root.findAll((found) => found.props.testID === "materialLibrarySearchField" && typeof found.props.onChangeText === "function")[0]!;
  expect(field.props.placeholder).toBe("Search History");
  expect(node(root, "materialLibraryTabs")).toBeUndefined();
  act(() => {
    field.props.onChangeText("site2");
  });
  expect(pressables(root, "materialLibraryHistoryRow")).toHaveLength(1);
  act(() => {
    claimed.at(-1)!.onCommit?.();
  });
  expect(node(root, "materialLibrarySearchField")).toBeUndefined();
  expect(pressables(root, "materialLibraryHistoryRow")).toHaveLength(2);
  expect(useLibrary.getState().open).toBe(true);
  unmount(root);
});

onAndroid("bookmark folders push a page with the folder's name, and Back pops it before it closes the library", () => {
  act(() => withSyncedBookmarks([bookmark("news", "News", null, "bar", [bookmark("bbc", "BBC", "https://bbc.co.uk/", null)]), bookmark("hn", "Hacker News", "https://news.ycombinator.com/", "bar")]));
  openAt("bookmarks");
  const root = libraryAlone();
  expect(textOf(root)).toContain("Bookmarks Bar");
  act(() => {
    pressable(root, "materialLibraryFolderRow").props.onPress();
  });
  expect(useLibrary.getState().path).toEqual(["folder:news"]);
  expect(textNode(node(root, "materialLibraryBar")!, "News")).toBeDefined();
  expect(node(root, "materialLibraryTabs")).toBeUndefined();
  expect(pressables(root, "materialLibraryBookmarkRow")).toHaveLength(1);
  act(() => {
    claimed.at(-1)!.onCommit?.();
  });
  expect(useLibrary.getState().path).toEqual([]);
  expect(useLibrary.getState().open).toBe(true);
  unmount(root);
});

onAndroid("predictive Back's progress and cancel keep the library open, and its commit closes it, which then leaves and unmounts", () => {
  openAt("downloads");
  const root = libraryAlone();
  expect(claimed).toHaveLength(1);
  act(() => {
    claimed[0]!.onProgress?.(0.5, "left");
    claimed[0]!.onCancel?.();
  });
  expect(useLibrary.getState().open).toBe(true);
  act(() => {
    claimed[0]!.onCommit?.();
  });
  expect(useLibrary.getState().open).toBe(false);
  expect(claimed).toHaveLength(0);
  act(() => jest.advanceTimersByTime(1000));
  expect(node(root, "materialLibrary")).toBeUndefined();
  unmount(root);
});

onAndroid("the back arrow closes the library", () => {
  openAt("history");
  const root = libraryAlone();
  act(() => {
    pressable(root, "materialLibraryBack").props.onPress();
  });
  expect(useLibrary.getState().open).toBe(false);
  unmount(root);
});

onAndroid("downloads list each file as a two-line item with its size and date", () => {
  act(() => useLibrary.setState({ files: [file(1), file(2)], filesLoaded: true }));
  openAt("downloads");
  const root = libraryAlone();
  const rows = pressables(root, "materialLibraryDownloadRow");
  expect(rows).toHaveLength(2);
  expect(textOf(root)).toContain("report-1.pdf");
  expect(textOf(root)).toContain("1.2 MB");
  unmount(root);
});

test("with Remove animations the library comes and goes at once on Android; otherwise it enters in 250 ms and leaves in 150 ms", () => {
  expect(materialLibraryMs(true, true)).toBe(Platform.OS === "android" ? 0 : 150);
  expect(materialLibraryMs(false, true)).toBe(250);
  expect(materialLibraryMs(false, false)).toBe(150);
});

test("Back ends a search first, then pops a folder, then closes the library", () => {
  expect(libraryBackStep(true, 1)).toBe("endSearch");
  expect(libraryBackStep(false, 2)).toBe("popFolder");
  expect(libraryBackStep(false, 0)).toBe("close");
});
