import { Platform } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { deckGeometry } from "../lib/deckGeometry";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { NO_LAUNCH_ARGUMENTS } from "../lib/launchArguments";
import * as launchFlags from "../state/app/launchFlags";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const SCREEN_CORNER = 12;

jest.mock("../platform/system", () => ({ ...jest.requireActual<object>("../platform/system"), displayCornerRadius: () => 12 }));

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => NO_LAUNCH_ARGUMENTS);
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Card = { scale: number; corner: number; z: number };

const expandedCard = (root: ReactTestRenderer): Card | null => {
  const cards = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string").map((node): Card => {
    const style = getAnimatedStyle(node) as { zIndex?: number; borderRadius?: number; transform?: { scale?: number }[] };
    const scale = (style.transform ?? []).reduce((value, step) => (step.scale === undefined ? value : step.scale), 1);
    return { scale, corner: (style.borderRadius ?? 0) * scale, z: style.zIndex ?? 0 };
  });
  return cards.sort((a, b) => b.z - a.z)[0] ?? null;
};

onAndroid("a deck card lands on the page's own bounds and the screen's own corner before the page takes over, so the hand-over doesn't jump or square its corners", () => {
  const root = renderSurface(<Surfaces />);
  const g = deckGeometry(393, 873, 40, 24, 0, "android", "original", deckHeaderBottom(), SCREEN_CORNER);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let last: Card | null = null;
  for (let frame = 0; frame < 120 && useBrowse.getState().surface === "deck"; frame++) {
    last = expandedCard(root) ?? last;
    act(() => jest.advanceTimersByTime(16));
  }
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(last).not.toBeNull();
  expect(last!.scale).toBeCloseTo(g.width / g.cardWidth, 4);
  expect(last!.corner).toBeCloseTo(SCREEN_CORNER, 4);
  unmount(root);
});
