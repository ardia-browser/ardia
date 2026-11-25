import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { MaterialBarProvider, PersistentMaterialBar, useMaterialBarRegistration } from "../components/browsing/PersistentMaterialBar";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { materialBarPill, materialBottomBar } from "../components/ui/materialTokens";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { useBrowse } from "../state/browse/store";
import { closePageMenu } from "../state/page/actions";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { useSearch } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, updateSurface, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const noop = () => undefined;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  setPreference("collapsesBottomBar", null);
  usePages.setState({ navigation: {} });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null, veiled: null, covered: null });
  useSearch.setState({ open: false });
  closePageMenu();
});
afterEach(() => {
  setPreference("collapsesBottomBar", null);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, id: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id);

onAndroid("the app keeps exactly one mounted bar through page, deck, search and fullscreen changes", () => {
  const root = renderSurface(<Surfaces />);
  const shell = hosts(root, "materialBottomBar")[0]!;
  expect(root.root.findAll((node) => node.type === MaterialBottomBar)).toHaveLength(1);
  expect(hosts(root, "materialBarTabs")).toHaveLength(1);
  expect(shell.props.pointerEvents).toBe("auto");
  for (let round = 0; round < 2; round++) {
    act(() => useBrowse.setState({ surface: "deck", deckEntrance: null, leaving: null }));
    expect(root.root.findAll((node) => node.type === MaterialBottomBar)).toHaveLength(1);
    expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
    expect(hosts(root, "deckSearchField")).toHaveLength(1);
    expect(hosts(root, "materialBarTabs")).toHaveLength(0);
    expect(hosts(root, "pageBarGhost")).toHaveLength(0);
    act(() => useBrowse.setState({ surface: "browsing" }));
    expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
    expect(hosts(root, "materialBarTabs")).toHaveLength(1);
    expect(hosts(root, "deckSearchField")).toHaveLength(0);
  }
  act(() => useSearch.setState({ open: true }));
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(shell.props.pointerEvents).toBe("none");
  expect(shell.props.accessibilityElementsHidden).toBe(true);
  expect(getAnimatedStyle(shell).opacity).toBe(1);
  expect(StyleSheet.flatten(hosts(root, "materialAddressField")[0]!.props.style).opacity).toBe(0);
  expect(hosts(root, "materialBarPlus")).toHaveLength(1);
  act(() => useSearch.setState({ open: false }));
  expect(shell.props.pointerEvents).toBe("none");
  expect(getAnimatedStyle(shell).opacity).toBe(1);
  expect(StyleSheet.flatten(hosts(root, "materialAddressField")[0]!.props.style).opacity).toBe(0);
  for (let frame = 0; frame < 25; frame++) {
    act(() => jest.advanceTimersByTime(16));
    expect(getAnimatedStyle(shell).opacity).toBe(1);
    expect(hosts(root, "materialBarPlus")).toHaveLength(1);
  }
  expect(shell.props.pointerEvents).toBe("auto");
  expect(StyleSheet.flatten(hosts(root, "materialAddressField")[0]!.props.style).opacity).not.toBe(0);
  const id = currentTabs().selectedId!;
  act(() => usePages.setState({ fullscreen: { [id]: true } }));
  expect(shell.props.pointerEvents).toBe("none");
  act(() => usePages.setState({ fullscreen: {} }));
  expect(shell.props.pointerEvents).toBe("auto");
  act(() => {
    withTabs(0);
    useBrowse.setState({ surface: "start" });
  });
  expect(root.root.findAll((node) => node.type === MaterialBottomBar)).toHaveLength(1);
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(hosts(root, "materialStartSearch")).toHaveLength(1);
  expect(hosts(root, "materialStartBottomBar")).toHaveLength(0);
  expect(StyleSheet.flatten(shell.props.style)).toMatchObject({ backgroundColor: "transparent", elevation: 0 });
  expect(shell.props.pointerEvents).toBe("auto");
  act(() => useSearch.setState({ open: true }));
  expect(shell.props.pointerEvents).toBe("none");
  act(() => useSearch.setState({ open: false }));
  act(() => jest.advanceTimersByTime(400));
  expect(shell.props.pointerEvents).toBe("auto");
  unmount(root);
});

onAndroid("the docked page menu renders over the same visible bottom bar and blocks it through dismissal", async () => {
  const root = renderSurface(<Surfaces />);
  const shell = hosts(root, "materialBottomBar")[0]!;
  const shortcut = root.root.findAll((node) => node.props.testID === "materialBarSiteSettings" && typeof node.props.onPress === "function")[0]!;
  await act(async () => { await shortcut.props.onPress(); });
  const layers = root.root.findAll((node) => typeof node.type === "string" && ["materialBottomBar", "materialScrim", "materialSheet"].includes(node.props.testID));
  expect(layers.map((layer) => layer.props.testID)).toEqual(["materialBottomBar", "materialScrim", "materialSheet"]);
  expect(layers[0]).toBe(shell);
  const barStyle = StyleSheet.flatten(shell.props.style);
  expect(barStyle.opacity).not.toBe(0);
  expect(StyleSheet.flatten(hosts(root, "siteSettingsLayer")[0]!.props.style).elevation).toBeGreaterThan(barStyle.elevation);
  expect(shell.props.pointerEvents).toBe("none");
  expect(shell.props.importantForAccessibility).toBe("no-hide-descendants");
  act(() => closePageMenu());
  expect(shell.props.pointerEvents).toBe("none");
  act(() => jest.advanceTimersByTime(1000));
  expect(hosts(root, "materialSheet")).toHaveLength(0);
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(shell.props.pointerEvents).toBe("auto");
  await act(async () => { await shortcut.props.onPress(); });
  for (let frame = 0; frame < 60; frame++) act(() => jest.advanceTimersByTime(16));
  const findRow = root.root.findAll((node) => node.props.testID === "pageMenuRow:Find on Page" && typeof node.props.onPress === "function")[0]!;
  act(() => findRow.props.onPress());
  for (let frame = 0; frame < 60; frame++) act(() => jest.advanceTimersByTime(16));
  expect(hosts(root, "materialFindBar")).toHaveLength(1);
  expect(StyleSheet.flatten(shell.props.style)).toMatchObject({ opacity: 0, elevation: 0 });
  expect(shell.props.pointerEvents).toBe("none");
  const closeFindButton = root.root.findAll((node) => node.props.accessibilityLabel === "Close Find" && typeof node.props.onPress === "function")[0]!;
  act(() => closeFindButton.props.onPress());
  expect(hosts(root, "materialFindBar")).toHaveLength(0);
  expect(StyleSheet.flatten(shell.props.style).opacity).not.toBe(0);
  expect(shell.props.pointerEvents).toBe("auto");
  unmount(root);
});

function PageRegistration({ blocked }: { blocked: boolean }) {
  const tab = currentTabs().open.find((tab) => tab.id === currentTabs().selectedId)!;
  useMaterialBarRegistration("page", {
    tabId: tab.id,
    blocked,
    bar: { isTabOverview: false, scheme: SEEDED_SCHEMES.ardia.light, tab, order: currentTabs().open, showsPlus: true, onAddress: noop, onTabs: noop, onTabsMenu: noop, onStep: noop, onPlus: noop, onMore: noop, onSiteSettings: noop },
  });
  return null;
}

onAndroid("a missing registration or blocked overlay hides interaction without unmounting the shell", () => {
  const view = (registered: boolean, blocked = false) => <MaterialBarProvider enabled>{registered ? <PageRegistration blocked={blocked} /> : null}<PersistentMaterialBar /></MaterialBarProvider>;
  const root = renderSurface(view(true));
  const shell = hosts(root, "materialBottomBar")[0]!;
  updateSurface(root, view(false));
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(StyleSheet.flatten(shell.props.style).opacity).toBe(0);
  expect(shell.props.pointerEvents).toBe("none");
  expect(shell.props.accessibilityElementsHidden).toBe(true);
  updateSurface(root, view(true, true));
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(shell.props.pointerEvents).toBe("none");
  updateSurface(root, view(true));
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(shell.props.pointerEvents).toBe("auto");
  unmount(root);
});

onAndroid("scrolling a page down folds the persistent Material bottom bar into a host pill, scrolling up brings it back, and switching to deck restores it", () => {
  const scroll = (scrollDirection: PageState["scrollDirection"]) => {
    const tab = currentTabs().open.find((entry) => entry.id === currentTabs().selectedId)!;
    act(() => storeNavigation(tab.id, { url: tab.url, title: tab.title, canGoBack: false, canGoForward: false, isLoading: false, progress: 1, scrollDirection } as unknown as PageState));
  };
  const settle = () => { for (let frame = 0; frame < 60; frame++) act(() => jest.advanceTimersByTime(16)); };
  const motion = (node: ReturnType<typeof hosts>[number]) => {
    const animated = getAnimatedStyle(node) as { opacity?: number; transform?: Array<{ translateY?: number }> };
    const translateY = animated.transform?.find((entry) => typeof entry.translateY === "number")?.translateY;
    return { opacity: Math.round((animated.opacity ?? 0) * 100) / 100, translateY: Math.round((translateY ?? 0) * 10) / 10 };
  };

  scroll("up");
  const root = renderSurface(<Surfaces />);
  const shell = hosts(root, "materialBottomBar")[0]!;
  const folded = Math.round((materialBottomBar.height / 2) * (1 - materialBarPill.collapsedScale) * 10) / 10;

  scroll("down");
  settle();
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(motion(shell)).toEqual({ opacity: 0, translateY: folded });
  expect(shell.props.pointerEvents).toBe("none");
  expect(shell.props.accessibilityElementsHidden).toBe(true);
  const pill = hosts(root, "materialBarPillPlace")[0]!;
  expect(motion(pill)).toEqual({ opacity: 1, translateY: 0 });
  expect(pill.props.pointerEvents).toBe("box-none");
  expect(pill.props.accessibilityElementsHidden).toBe(false);

  act(() => useBrowse.setState({ surface: "deck", deckEntrance: null, leaving: null }));
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(motion(shell)).toEqual({ opacity: 1, translateY: 0 });
  expect(shell.props.pointerEvents).toBe("auto");

  act(() => useBrowse.setState({ surface: "browsing" }));
  scroll("up");
  settle();
  expect(hosts(root, "materialBottomBar")[0]).toBe(shell);
  expect(motion(shell)).toEqual({ opacity: 1, translateY: 0 });
  expect(shell.props.pointerEvents).toBe("auto");
  expect(shell.props.accessibilityElementsHidden).toBe(false);

  unmount(root);
});
