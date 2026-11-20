import { Keyboard, Platform, type KeyboardEvent } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { DeckBottomBar } from "../components/tabs/DeckBottomBar";
import { deckChromeLayout } from "../components/ui";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const SAFE_BOTTOM = 24;
const DECK_HEIGHT = 873;
const BAR_CENTER = DECK_HEIGHT - SAFE_BOTTOM - 40;
const KEYBOARD = 300;

let listeners: Map<string, ((event: KeyboardEvent) => void)[]>;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  listeners = new Map();
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(Keyboard, "metrics").mockReturnValue(undefined);
  jest.spyOn(Keyboard, "addListener").mockImplementation((name, listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    return { remove: () => listeners.set(name, (listeners.get(name) ?? []).filter((one) => one !== listener)) } as never;
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const showKeyboard = (height: number) => {
  const name = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
  const reported = Platform.OS === "ios" ? height + SAFE_BOTTOM : height;
  act(() => (listeners.get(name) ?? []).forEach((listener) => listener({ endCoordinates: { height: reported, screenX: 0, screenY: DECK_HEIGHT - reported, width: 393 } } as never)));
};

const placeOf = (root: ReturnType<typeof renderSurface>) => {
  let node: ReactTestInstance | null = root.root.findAll((one) => one.props.testID === "deckBottomBar" && typeof one.type === "string")[0]!.parent;
  while (node && typeof node.type !== "string") node = node.parent;
  return node!;
};

const rise = (root: ReturnType<typeof renderSurface>) => {
  const transform = (getAnimatedStyle(placeOf(root)).transform ?? []) as { translateY?: number }[];
  return transform.find((step) => step.translateY !== undefined)?.translateY ?? 0;
};

test("a focused Search Tabs field rises until the deck bar's bottom sits its gap above the keyboard's top, on both phones, Android's keyboard height leaving out the navigation bar", () => {
  const root = renderSurface(<DeckBottomBar shown barCenterY={BAR_CENTER} deckHeight={DECK_HEIGHT} safeSide={0} incognito={false} onQuery={() => undefined} />);
  expect(rise(root)).toBe(0);
  const field = root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onFocus === "function")[0]!;
  act(() => field.props.onFocus());
  showKeyboard(KEYBOARD);
  act(() => jest.advanceTimersByTime(1000));
  const keyboardTop = DECK_HEIGHT - KEYBOARD - SAFE_BOTTOM;
  const barBottom = BAR_CENTER + rise(root) + deckChromeLayout.barCircle / 2;
  expect(barBottom).toBeCloseTo(keyboardTop - deckChromeLayout.barGap, 5);
  unmount(root);
});
