import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { useBrowse } from "../state/browse/store";
import { storeNavigation, storeTone, usePages, type PageState } from "../state/pages/store";
import { rememberPageTones, restorePageTones } from "../state/pages/toneMemory";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const colour = (node: ReactTestInstance) => {
  let animated: unknown;
  try {
    animated = getAnimatedStyle(node).backgroundColor;
  } catch {
    animated = undefined;
  }
  const value = animated ?? StyleSheet.flatten(node.props.style)?.backgroundColor;
  return typeof value === "number" ? `#${(value & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}` : value;
};

const shows = (root: ReturnType<typeof renderSurface>, hex: string, rgba: string) =>
  root.root
    .findAll((node) => typeof node.type === "string")
    .map(colour)
    .some((value) => value === hex || value === rgba);

const page = (tab: { url: string; title: string }, isLoading: boolean) => ({ isLive: true, isLoading, url: tab.url, title: tab.title, failure: null, progress: 1 }) as unknown as PageState;

test("while a page's cover is up its reports don't reach the bars; they keep the tab's colours, and take the page's latest report the moment the cover lifts", () => {
  const tab = currentTabs().open[0]!;
  act(() => storeTone(tab.id, { top: "#101820", bottom: "#203040" }));
  const root = renderSurface(<BrowsingScreen tab={tab} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(16));
  expect(root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")).toHaveLength(1);
  act(() => storeTone(tab.id, { top: "#101820", bottom: "#304050" }));
  act(() => jest.advanceTimersByTime(400));
  expect(shows(root, "#203040", "rgba(32, 48, 64, 1)")).toBe(true);
  expect(shows(root, "#304050", "rgba(48, 64, 80, 1)")).toBe(false);
  act(() => storeNavigation(tab.id, page(tab, true)));
  act(() => storeNavigation(tab.id, page(tab, false)));
  act(() => jest.advanceTimersByTime(330));
  expect(root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")).toHaveLength(0);
  expect(usePages.getState().heldTones[tab.id]).toBeUndefined();
  act(() => jest.advanceTimersByTime(500));
  expect(shows(root, "#304050", "rgba(48, 64, 80, 1)")).toBe(true);
  unmount(root);
});

test("if the page hasn't reported since its cover went up, the bars keep the tab's colours after the cover lifts, with no time limit, until its first report", () => {
  const tab = currentTabs().open[0]!;
  act(() => storeTone(tab.id, { top: "#101820", bottom: "#203040" }));
  const root = renderSurface(<BrowsingScreen tab={tab} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(16));
  act(() => storeNavigation(tab.id, page(tab, true)));
  act(() => storeNavigation(tab.id, page(tab, false)));
  act(() => jest.advanceTimersByTime(330));
  act(() => jest.advanceTimersByTime(5000));
  expect(usePages.getState().heldTones[tab.id]).toEqual({ top: "#101820", bottom: "#203040" });
  act(() => storeTone(tab.id, { top: "#101820", bottom: "#304050" }));
  expect(usePages.getState().heldTones[tab.id]).toBeUndefined();
  act(() => jest.advanceTimersByTime(500));
  expect(shows(root, "#304050", "rgba(48, 64, 80, 1)")).toBe(true);
  unmount(root);
});

test("a tab's last colours are written a moment after they change and come back at the next launch, so a page that must reload after a restart shows them, not the app's tint", () => {
  const tab = currentTabs().open[0]!;
  const stop = rememberPageTones(() => new Set([tab.id]));
  act(() => storeTone(tab.id, { top: "#101820", bottom: "#203040" }));
  act(() => jest.advanceTimersByTime(2000));
  stop();
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  restorePageTones(new Set([tab.id]));
  expect(usePages.getState().lastTones[tab.id]).toEqual({ top: "#101820", bottom: "#203040" });
  restorePageTones(new Set(["some-other-tab"]));
  usePages.setState({ lastTones: {} });
  restorePageTones(new Set(["some-other-tab"]));
  expect(usePages.getState().lastTones).toEqual({});
});
