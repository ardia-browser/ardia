import { Platform } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { deckGeometry } from "../lib/deckGeometry";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => ({ ...jest.requireActual("@ardia/phone-native"), pageObscuresInsets: () => true }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  useTabs.setState((state) => ({ open: state.open.map((tab) => ({ ...tab, themeColorHex: "#2B5B84", snapshotFileName: `file:///snapshots/${tab.id}.jpg` })) }));
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const translateY = (node: ReactTestInstance) => ((getAnimatedStyle(node).transform as { translateY?: number }[] | undefined) ?? []).reduce((sum, step) => sum + (step.translateY ?? 0), 0);
const scaleY = (node: ReactTestInstance) => ((getAnimatedStyle(node).transform as { scaleY?: number }[] | undefined) ?? []).reduce((value, step) => (step.scaleY === undefined ? value : step.scaleY), 1);
const found = (root: ReturnType<typeof renderSurface>, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");

function openFocused(design: Design) {
  const root = renderSurface(
    <DesignProvider design={design}>
      <Surfaces />
    </DesignProvider>,
  );
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let drop = 0;
  let band = 0;
  let elapsed = 0;
  let landed = false;
  while (useBrowse.getState().surface === "deck" && elapsed < 1000) {
    act(() => jest.advanceTimersByTime(16));
    elapsed += 16;
    if (!landed && useBrowse.getState().opening !== null) landed = landOpeningPage(root);
    for (const face of found(root, "deckCardFace")) drop = Math.max(drop, translateY(face));
    for (const grown of found(root, "deckCardBarBand")) band = Math.max(band, scaleY(grown));
  }
  unmount(root);
  return { drop, band, elapsed, opened: currentTabs().selectedId };
}

test("when the page runs under the status bar and the bar, an opening card adds no status strip or bar band to its picture, which already holds both, so the page doesn't jump when it takes over", () => {
  const { drop, band } = openFocused("redesigned");
  expect(drop).toBe(0);
  expect(band).toBe(0);
});

test("a page that sits below the status bar still has the card grow a strip above its picture", () => {
  const g = deckGeometry(393, 873, 40, 24);
  const { drop } = openFocused("original");
  expect(drop * (g.width / g.cardWidth)).toBeGreaterThan(36);
});

test("on iPhone an opening card's page takes over by SwiftUI's expand spring, response 0.18 s, not Compose's 0.3 s", () => {
  const { elapsed } = openFocused("redesigned");
  if (Platform.OS === "ios") expect(elapsed).toBeLessThan(300);
  else expect(elapsed).toBeLessThan(450);
});
