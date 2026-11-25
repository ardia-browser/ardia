import { ActionSheetIOS, Platform } from "react-native";
import { act } from "react-test-renderer";
import "../platform/copy";
import { SyncPage } from "../components/sync/SyncPage";
import * as syncActions from "../state/sync/actions";
import { useSync } from "../state/sync/store";
import { NOW, status, view } from "../../test/syncFixture";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  withTabs(1);
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: true, phase: "updated" }), view: view() }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const symbols = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.props.name === "string" && node.props.size === 22 && typeof node.type !== "string").map((node) => node.props.name as string);

onAndroid("on Android the devices say when each was seen in Compose's abbreviated words, and Stop Syncing asks in the app's dialog", async () => {
  const root = renderSurface(<SyncPage />);
  const text = textOf(root);
  expect(text).toContain("3 hr. ago");
  expect(text).toContain("Just Now");
  expect(text).toContain("This Phone");
  expect(symbols(root)).toContain("macDesktop");
  const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions");
  await pressButton(root, "Stop Syncing…");
  expect(sheet).not.toHaveBeenCalled();
  expect(textOf(root)).toContain("Stop Syncing This Device?");
  unmount(root);
});

onIos("on iPhone the other devices show no time, as SwiftUI's rows, the Studio has its own symbol, and Stop Syncing is a system action sheet", async () => {
  const stop = jest.spyOn(syncActions, "stopSyncing").mockImplementation(async () => undefined);
  const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((_options, answer) => answer(0));
  const root = renderSurface(<SyncPage />);
  const text = textOf(root);
  expect(text).not.toContain("ago");
  expect(text).not.toContain("Just Now");
  expect(text).toContain("This iPhone");
  expect(symbols(root)).toEqual(expect.arrayContaining(["macStudio", "laptop", "iphone"]));
  await pressButton(root, "Stop Syncing…");
  expect(sheet).toHaveBeenCalledWith(expect.objectContaining({ title: "Stop Syncing This Device?", options: ["Stop Syncing", "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 }), expect.any(Function));
  await act(async () => {});
  expect(stop).toHaveBeenCalledTimes(1);
  expect(textOf(root)).not.toContain("you’ll need your Mac’s code");
  unmount(root);
});
