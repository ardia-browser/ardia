import { Platform, Text } from "react-native";
import { act } from "react-test-renderer";
import { useTrayKeyboard } from "../components/search/useTrayKeyboard";
import { renderSurface, textOf, unmount } from "../../test/render/harness";

const mockListeners = new Set<(change: { source: number; target: number; durationMs: number; navigationBar: number }) => void>();
const mockSettled = new Set<(change: { height: number; navigationBar: number }) => void>();

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return {
    ...actual,
    keyboard: {
      isAvailable: () => true,
      current: () => ({ height: 0, navigationBar: 24 }),
      addWillChangeListener: (listener: (change: { source: number; target: number; durationMs: number; navigationBar: number }) => void) => {
        mockListeners.add(listener);
        return { remove: () => mockListeners.delete(listener) };
      },
      addDidChangeListener: (listener: (change: { height: number; navigationBar: number }) => void) => {
        mockSettled.add(listener);
        return { remove: () => mockSettled.delete(listener) };
      },
    },
  };
});

function Probe() {
  const keyboard = useTrayKeyboard();
  return <Text>{`target ${keyboard.target} full ${keyboard.full.value}`}</Text>;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const onAndroid = Platform.OS === "android" ? test : test.skip;

onAndroid("on Android the tray takes the keyboard's height as its animation starts, so the first keyboard of a process lands right", () => {
  const root = renderSurface(<Probe />);
  expect(textOf(root)).toContain("target 0");
  act(() => mockListeners.forEach((listener) => listener({ source: 0, target: 312, durationMs: 250, navigationBar: 24 })));
  expect(textOf(root)).toContain("target 312 full 312");
  act(() => mockListeners.forEach((listener) => listener({ source: 312, target: 0, durationMs: 250, navigationBar: 24 })));
  expect(textOf(root)).toContain("target 0 full 312");
  unmount(root);
  expect(mockListeners.size).toBe(0);
});

onAndroid("on Android a turn with the keyboard up, which sends only the keyboard's settled height, moves the tray to the new keyboard: landscape's shorter one and back", () => {
  const root = renderSurface(<Probe />);
  act(() => mockListeners.forEach((listener) => listener({ source: 0, target: 326, durationMs: 250, navigationBar: 24 })));
  expect(textOf(root)).toContain("target 326 full 326");
  act(() => mockSettled.forEach((listener) => listener({ height: 213, navigationBar: 0 })));
  expect(textOf(root)).toContain("target 213 full 213");
  act(() => mockSettled.forEach((listener) => listener({ height: 326, navigationBar: 24 })));
  expect(textOf(root)).toContain("target 326 full 326");
  act(() => mockSettled.forEach((listener) => listener({ height: 0, navigationBar: 24 })));
  expect(textOf(root)).toContain("target 0 full 326");
  unmount(root);
  expect(mockSettled.size).toBe(0);
});
