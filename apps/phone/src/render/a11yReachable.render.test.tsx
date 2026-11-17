import { StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import * as browse from "../state/browse/store";
import { closePageMenu, openPageMenu } from "../state/page/actions";
import { cancelSearch, submitSearch } from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import { closeSettings, openSettings } from "../state/settings/nav";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root) => root.root.findAll((node) => typeof node.type === "string");
const ancestors = (node: ReactTestInstance) => {
  const chain: ReactTestInstance[] = [];
  for (let at: ReactTestInstance | null = node; at; at = at.parent) chain.push(at);
  return chain;
};
const hiddenFromScreenReader = (node: ReactTestInstance) => ancestors(node).some((at) => typeof at.type === "string" && (at.props.accessibilityElementsHidden === true || at.props.importantForAccessibility === "no-hide-descendants"));
const fillsScreen = (node: ReactTestInstance) => {
  const style = StyleSheet.flatten(node.props.style) ?? {};
  return style.position === "absolute" && style.top === 0 && style.left === 0 && style.right === 0 && style.bottom === 0 && style.display !== "none" && style.opacity !== 0;
};

export function blockers(root: Root, target: ReactTestInstance): string[] {
  const own = new Set(ancestors(target));
  return hosts(root)
    .filter((node) => !own.has(node) && !hiddenFromScreenReader(node))
    .filter((node) => node.props.accessibilityViewIsModal === true || (node.props.pointerEvents === "none" && node.props.collapsable === false && fillsScreen(node)))
    .map((node) => String(node.props.testID ?? node.props.accessibilityLabel ?? "unnamed"));
}

function tabsButton(root: Root) {
  const found = hosts(root).filter((node) => node.props.accessibilityLabel === "Tabs");
  if (!found.length) throw new Error("no Tabs button on the page");
  return found[0]!;
}

function expectPageReachable(root: Root) {
  const tabs = tabsButton(root);
  expect(hiddenFromScreenReader(tabs)).toBe(false);
  expect(blockers(root, tabs)).toEqual([]);
}

async function settle() {
  for (let step = 0; step < 40; step++) await act(async () => void jest.advanceTimersByTime(100));
}

test("after a search is submitted and the panel has left, the page is reachable by a screen reader again, search after search", async () => {
  jest.spyOn(browse, "submitSearch").mockImplementation(() => {
    useSearch.setState({ open: false, ending: "submitted" } as never);
    return true;
  });
  const root = renderSurface(<Surfaces />);
  expectPageReachable(root);
  for (let round = 0; round < 3; round++) {
    act(() => presentSearch("page", `otters ${round}`));
    await settle();
    act(() => void submitSearch("otters"));
    await settle();
    expectPageReachable(root);
    expect(hosts(root).filter((node) => node.props.testID === "trayRoot")).toHaveLength(0);
  }
  unmount(root);
});

test("after search is cancelled the page is reachable again", async () => {
  const root = renderSurface(<Surfaces />);
  act(() => presentSearch("page", ""));
  await settle();
  act(() => cancelSearch());
  await settle();
  expectPageReachable(root);
  unmount(root);
});

test("after the page menu, Settings and the Archive close, the page is reachable again", async () => {
  const root = renderSurface(<Surfaces />);
  await act(async () => void openPageMenu());
  await settle();
  act(() => closePageMenu());
  await settle();
  expectPageReachable(root);
  act(() => openSettings());
  await settle();
  act(() => closeSettings());
  await settle();
  expectPageReachable(root);
  act(() => browse.openArchive());
  await settle();
  act(() => browse.closeArchive());
  await settle();
  expectPageReachable(root);
  unmount(root);
});

test("after the deck shows and a card takes the page back, the page is reachable again", async () => {
  const root = renderSurface(<Surfaces />);
  act(() => browse.useBrowse.setState({ surface: "deck" }));
  await settle();
  act(() => browse.useBrowse.setState({ surface: "browsing" }));
  await settle();
  expectPageReachable(root);
  unmount(root);
});
