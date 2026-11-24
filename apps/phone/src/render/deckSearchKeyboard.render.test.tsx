import { Keyboard, Platform, type KeyboardEvent } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { DeckBottomBar } from "../components/tabs/DeckBottomBar";
import { deckChromeLayout } from "../components/ui";
import { redesignedBarCenterFromBottom } from "../lib/deckGeometry";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const SAFE_BOTTOM = 24;
const DECK_HEIGHT = 873;
const BAR_CENTER = DECK_HEIGHT - redesignedBarCenterFromBottom(SAFE_BOTTOM, Platform.OS);
const KEYBOARD = 300;

let listeners: Map<string, ((event: KeyboardEvent) => void)[]>;
let liveKeyboard: { height: ReturnType<typeof makeMutable<number>>; state: ReturnType<typeof makeMutable<KeyboardState>> };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  listeners = new Map();
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(Keyboard, "metrics").mockReturnValue(undefined);
  liveKeyboard = { height: makeMutable(0), state: makeMutable<KeyboardState>(KeyboardState.CLOSED) };
  jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => liveKeyboard as never);
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

const placeOf = (root: ReturnType<typeof renderSurface>) => {
  let node: ReactTestInstance | null = root.root.findAll((one) => one.props.testID === "deckBottomBar" && typeof one.type === "string")[0]!.parent;
  while (node && typeof node.type !== "string") node = node.parent;
  return node!;
};

const rise = (root: ReturnType<typeof renderSurface>) => {
  const transform = (getAnimatedStyle(placeOf(root)).transform ?? []) as { translateY?: number }[];
  return transform.find((step) => step.translateY !== undefined)?.translateY ?? 0;
};

const keyboardAt = (fromScreenBottom: number) => act(() => void (liveKeyboard.height.value = fromScreenBottom));

const onIPhone = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

const showKeyboard = (height: number) => act(() => (listeners.get("keyboardDidShow") ?? []).forEach((listener) => listener({ endCoordinates: { height, screenX: 0, screenY: DECK_HEIGHT - height, width: 393 } } as never)));

onAndroid("on Android a focused Search Tabs field rises until the deck bar's bottom sits its gap above the keyboard's top, the keyboard's height leaving out the navigation bar, and the deck never subscribes to the live keyboard, so the window keeps resizing for pages", () => {
  const keyboardHook = jest.spyOn(Reanimated, "useAnimatedKeyboard");
  const root = renderSurface(<DeckBottomBar shown barCenterY={BAR_CENTER} deckHeight={DECK_HEIGHT} width={402} layout={{ span: { left: 24, right: 24 }, strip: null }} incognito={false} onQuery={() => undefined} />);
  expect(rise(root)).toBe(0);
  const field = root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onFocus === "function")[0]!;
  act(() => field.props.onFocus());
  showKeyboard(KEYBOARD);
  act(() => jest.advanceTimersByTime(1000));
  const barBottom = BAR_CENTER + rise(root) + deckChromeLayout.barCircle / 2;
  expect(barBottom).toBeCloseTo(DECK_HEIGHT - KEYBOARD - SAFE_BOTTOM - deckChromeLayout.barGap, 5);
  expect(keyboardHook).not.toHaveBeenCalled();
  unmount(root);
});

onIPhone("on iPhone the live keyboard is followed only while the deck is shown", () => {
  const keyboardHook = jest.spyOn(Reanimated, "useAnimatedKeyboard");
  const hidden = renderSurface(<DeckBottomBar shown={false} barCenterY={BAR_CENTER} deckHeight={DECK_HEIGHT} width={402} layout={{ span: { left: 24, right: 24 }, strip: null }} incognito={false} onQuery={() => undefined} />);
  expect(keyboardHook).not.toHaveBeenCalled();
  unmount(hidden);
});

onIPhone("a focused Search Tabs field rides the keyboard frame by frame until the deck bar's bottom sits its gap above the keyboard's top", () => {
  const root = renderSurface(<DeckBottomBar shown barCenterY={BAR_CENTER} deckHeight={DECK_HEIGHT} width={402} layout={{ span: { left: 24, right: 24 }, strip: null }} incognito={false} onQuery={() => undefined} />);
  expect(rise(root)).toBe(0);
  const field = root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onFocus === "function")[0]!;
  act(() => field.props.onFocus());
  const barBottomAt = (keyboard: number) => {
    keyboardAt(keyboard);
    return BAR_CENTER + rise(root) + deckChromeLayout.barCircle / 2;
  };
  const full = KEYBOARD + SAFE_BOTTOM;
  expect(barBottomAt(full / 2)).toBeCloseTo(DECK_HEIGHT - full / 2 - deckChromeLayout.barGap, 5);
  expect(barBottomAt(full)).toBeCloseTo(DECK_HEIGHT - full - deckChromeLayout.barGap, 5);
  act(() => field.props.onBlur());
  expect(barBottomAt(full * 0.75)).toBeCloseTo(DECK_HEIGHT - full * 0.75 - deckChromeLayout.barGap, 5);
  keyboardAt(0);
  expect(rise(root)).toBe(0);
  keyboardAt(full);
  expect(rise(root)).toBe(0);
  unmount(root);
});
