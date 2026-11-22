import { getAnimatedStyle } from "react-native-reanimated";
import { BackHandler } from "react-native";
import { act } from "react-test-renderer";

type Handlers = { onProgress?: (progress: number, edge: "left" | "right") => void; onCancel?: () => void; onCommit?: () => void };

const mockBack = { enabled: [] as boolean[], handlers: null as Handlers | null };

jest.mock("../platform/back", () => ({
  TRAY_BACK_TRAVEL: 72,
  trayBack: {
    setEnabled: (on: boolean) => mockBack.enabled.push(on),
    listen: (handlers: Handlers) => {
      mockBack.handlers = handlers;
      return { remove: () => (mockBack.handlers = null) };
    },
  },
}));

const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
jest.mock("../components/ui/Overlay", () => ({
  ...jest.requireActual("../components/ui/Overlay"),
  useOverlayFrame: () => () => Promise.resolve({ x: 0, y: 0, width: 393, height: 873 }),
}));

const { SearchTray } = require("../components/search/SearchTray") as typeof import("../components/search/SearchTray");
const { presentSearch, useSearch } = require("../state/search/store") as typeof import("../state/search/store");
const { useVoice } = require("../state/voice/store") as typeof import("../state/voice/store");
const { useTrayCovers } = require("../state/search/trayBack") as typeof import("../state/search/trayBack");
const { renderSurface, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  mockBack.enabled = [];
  mockBack.handlers = null;
  useTrayCovers.setState({ covers: 0 });
  useVoice.setState({ presented: false });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const sheet = (root: ReturnType<typeof renderSurface>) =>
  root.root.findAll((node) => (node.props.testID === "trayPanel" || typeof node.props.style === "object") && typeof node.type === "string" && getAnimatedStyle(node)?.transform !== undefined && node.props.testID !== "trayDim")[0]!;
const lift = (node: ReturnType<typeof sheet>) => ((getAnimatedStyle(node).transform as { translateY?: number }[]) ?? []).reduce((sum, step) => sum + (step.translateY ?? 0), 0);

test("while the tray is up, Android's predictive back follows the swipe down by up to 72 points, springs back on cancel, closes on commit, and is switched off once the tray goes", () => {
  act(() => presentSearch("page", "otters"));
  const root = renderSurface(<SearchTray />);
  act(() => jest.advanceTimersByTime(600));
  expect(mockBack.enabled).toEqual([true]);
  const node = sheet(root);
  const resting = lift(node);
  act(() => mockBack.handlers!.onProgress!(0.5, "left"));
  act(() => jest.advanceTimersByTime(16));
  expect(lift(node) - resting).toBeCloseTo(36, 0);
  act(() => mockBack.handlers!.onCancel!());
  act(() => jest.advanceTimersByTime(800));
  expect(lift(node) - resting).toBeCloseTo(0, 0);
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  act(() => mockBack.handlers!.onCommit!());
  expect(counted).toHaveBeenCalledWith("tray_back_swiped");
  expect(useSearch.getState().open).toBe(false);
  act(() => jest.advanceTimersByTime(16));
  expect(mockBack.enabled).toEqual([true, false]);
  unmount(root);
  counted.mockRestore();
});

test("with a row's menu open over the tray, Back goes to the menu: the tray's native back is switched off first, so the menu closes and search stays open", async () => {
  act(() => presentSearch("page", "otters"));
  const root = renderSurface(<SearchTray />);
  act(() => jest.advanceTimersByTime(600));
  expect(mockBack.enabled).toEqual([true]);
  const listening = jest.spyOn(BackHandler, "addEventListener");
  const row = root.root.findAll((node) => typeof node.props.onMenu === "function" && node.props.row !== undefined && Array.isArray(node.props.menu) && node.props.menu.length > 0)[0]!;
  await act(async () => row.props.onMenu(row.props.row, { x: 120, y: 300 }));
  await act(async () => jest.advanceTimersByTime(50));
  expect(mockBack.enabled.at(-1)).toBe(false);
  expect(mockBack.handlers).toBeNull();
  expect(root.root.findAll((node) => node.props.testID === "drawnMenuScrim" && typeof node.type === "string").length).toBeGreaterThan(0);
  const backs = listening.mock.calls.filter((call) => call[0] === "hardwareBackPress").map((call) => call[1]);
  expect(backs.length).toBeGreaterThan(0);
  act(() => {
    for (const back of [...backs].reverse()) if (back({ type: "hardwareBackPress", timeStamp: 0 })) break;
  });
  listening.mockRestore();
  await act(async () => jest.advanceTimersByTime(500));
  expect(root.root.findAll((node) => node.props.testID === "drawnMenuScrim" && typeof node.type === "string")).toHaveLength(0);
  expect(useSearch.getState().open).toBe(true);
  expect(mockBack.enabled.at(-1)).toBe(true);
  unmount(root);
});

test("while voice search is up over the tray, the tray's native back stays off", () => {
  act(() => presentSearch("page", "otters"));
  const root = renderSurface(<SearchTray />);
  act(() => jest.advanceTimersByTime(600));
  act(() => useVoice.setState({ presented: true }));
  expect(mockBack.enabled.at(-1)).toBe(false);
  act(() => useVoice.setState({ presented: false }));
  expect(mockBack.enabled.at(-1)).toBe(true);
  unmount(root);
});

test("a suggestion's long-press menu stays above the keyboard: its floor is the keyboard's top, and with no keyboard it has none", async () => {
  const { Dimensions, Keyboard } = require("react-native") as typeof import("react-native");
  const { FloatingMenu } = require("../components/ui") as typeof import("../components/ui");
  const { keyboardTopFromBottom } = require("../components/search/useKeyboardHeight") as typeof import("../components/search/useKeyboardHeight");
  const height = Dimensions.get("window").height;
  for (const keyboard of [300, 0]) {
    const metrics = jest.spyOn(Keyboard, "metrics").mockReturnValue(keyboard ? { height: keyboard, screenX: 0, screenY: height - keyboard, width: 393 } : undefined);
    act(() => presentSearch("page", "otters"));
    const root = renderSurface(<SearchTray />);
    act(() => jest.advanceTimersByTime(600));
    const row = root.root.findAll((node) => typeof node.props.onMenu === "function" && node.props.row !== undefined && Array.isArray(node.props.menu) && node.props.menu.length > 0)[0]!;
    await act(async () => row.props.onMenu(row.props.row, { x: 120, y: height - keyboard - 20 }));
    const menu = root.root.findAll((node) => node.type === FloatingMenu)[0]!;
    if (keyboard) {
      const top = height - keyboardTopFromBottom(keyboard, 24);
      expect(menu.props.floor).toBe(top);
      const { Menu } = require("../components/ui") as typeof import("../components/ui");
      const placed = root.root.findAll((node) => node.type === Menu)[0]!.props.placer(160);
      expect(placed.place.top + placed.maxHeight).toBeLessThanOrEqual(top);
    } else {
      expect(menu.props.floor).toBeUndefined();
    }
    metrics.mockRestore();
    unmount(root);
    act(() => jest.runOnlyPendingTimers());
  }
});
