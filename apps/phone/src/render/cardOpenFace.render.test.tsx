import { Dimensions, Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider } from "../components/ui";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, openingCardWidth: null, veiled: null, covered: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root | ReactTestInstance, testID: string) => ("root" in root ? root.root : root).findAll((node) => node.props.testID === testID && typeof node.type === "string");
const texts = (node: ReactTestInstance) =>
  node
    .findAll((one) => one.type === "Text")
    .map((one) => one.props.children)
    .flat();

function openFocused() {
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <Surfaces />
    </DesignProvider>,
  );
  const cardWidth = StyleSheet.flatten(hosts(root, "deckCard")[0]!.props.style).width as number;
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let elapsed = 0;
  let landed = false;
  while (useBrowse.getState().surface === "deck" && elapsed < 1000) {
    act(() => jest.advanceTimersByTime(16));
    elapsed += 16;
    if (!landed && useBrowse.getState().opening !== null) landed = landOpeningPage(root);
  }
  return { root, cardWidth };
}

onAndroid("a card opened from the deck with no picture is covered by its face laid out at the card's width and scaled to the screen, as the grown card drew it, so nothing jumps smaller at the hand-over", () => {
  const { root, cardWidth } = openFocused();
  expect(useBrowse.getState().surface).toBe("browsing");
  const cover = hosts(root, "pageCover")[0]!;
  expect(hosts(cover, "pageLoadingPlaceholder")).toHaveLength(0);
  const face = hosts(cover, "pageCoverCardFace")[0]!;
  const style = StyleSheet.flatten(face.props.style) as { width: number; height: number; transform: { scale: number }[]; transformOrigin: string };
  const { width, height } = Dimensions.get("window");
  expect(style.width).toBeCloseTo(cardWidth, 5);
  expect(style.transform[0]!.scale).toBeCloseTo(width / cardWidth, 5);
  expect(style.height * style.transform[0]!.scale).toBeCloseTo(height, 5);
  expect(style.transformOrigin).toBe("left top");
  unmount(root);
});

onAndroid("the cover keeps the title the card showed while the loading page reports its host as the title", () => {
  const { root } = openFocused();
  const id = currentTabs().selectedId!;
  const title = currentTabs().open.find((tab) => tab.id === id)!.title;
  act(() => useTabs.setState((state) => ({ open: state.open.map((tab) => (tab.id === id ? { ...tab, title: "" } : tab)) })));
  const cover = hosts(root, "pageCover")[0]!;
  expect(texts(cover)[0]).toBe(title);
  unmount(root);
});
