import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import * as browse from "../state/browse/store";
import { openSettings, pushSettings, settingsNav } from "../state/settings/nav";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

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

const hosts = (root: Root, has: (props: Record<string, unknown>) => boolean) => root.root.findAll((node) => typeof node.type === "string" && has(node.props));
const systemSheet = (root: Root) => hosts(root, (props) => typeof props.isPresented === "boolean" && typeof props.onIsPresentedChange === "function")[0];
const handBuilt = (root: Root) => hosts(root, (props) => props.accessibilityViewIsModal === true);
const stackPath = (root: Root) => hosts(root, (props) => Array.isArray(props.path))[0]?.props.path;

onIos("on iPhone Settings opens in the system's own sheet with main's defaults, never inside the hand-built sheet we slide by transform; a drag down closes it, and a deep page stays put while the sheet leaves", async () => {
  const root = renderSurface(<Surfaces />);
  expect(systemSheet(root)!.props.isPresented).toBe(false);
  await act(async () => openSettings());
  await act(async () => void jest.advanceTimersByTime(600));
  expect(systemSheet(root)!.props.isPresented).toBe(true);
  expect(systemSheet(root)!.props.modifiers ?? []).toEqual([]);
  expect(handBuilt(root)).toHaveLength(0);
  await act(async () => pushSettings({ page: "appearance" }));
  expect(stackPath(root)).toEqual(["appearance"]);
  await act(async () => systemSheet(root)!.props.onIsPresentedChange({ nativeEvent: { isPresented: false } }));
  expect(settingsNav().open).toBe(false);
  expect(systemSheet(root)!.props.isPresented).toBe(false);
  expect(stackPath(root)).toEqual(["appearance"]);
  await act(async () => void jest.advanceTimersByTime(1000));
  unmount(root);
});

onAndroid("on Android Settings stays in the hand-built sheet until a measurement says otherwise", async () => {
  const root = renderSurface(<Surfaces />);
  await act(async () => openSettings());
  await act(async () => void jest.advanceTimersByTime(600));
  expect(systemSheet(root)).toBeUndefined();
  expect(handBuilt(root)).toHaveLength(1);
  await act(async () => void jest.advanceTimersByTime(1000));
  unmount(root);
});
