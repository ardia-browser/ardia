import { AppState, Dimensions, Linking, Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import "../platform/copy";
import { DefaultBrowserPage, DefaultBrowserSteps } from "../components/settings/DefaultBrowserPage";
import { ActionButton, AppIcon, PrimaryButton } from "../components/ui";
import { defaultBrowser } from "../platform/defaultBrowser";
import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { pressButton, renderSurface, textOf, unmount } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

const settle = () => act(async () => {});

const comeBack = () =>
  act(() => {
    const calls = (AppState.addEventListener as unknown as jest.Mock).mock?.calls ?? [];
    calls.forEach(([event, listener]: [string, (state: string) => void]) => event === "change" && listener("active"));
  });

let status: { isDefault: boolean; canAsk: boolean };

beforeEach(() => {
  jest.useFakeTimers();
  status = { isDefault: false, canAsk: false };
  useDefaultBrowser.setState({ status: null });
  jest.spyOn(defaultBrowser, "status").mockImplementation(async () => status);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

onIos("on iPhone the button opens the system's default apps page through the module, never the app's own Settings page, and the status is read again on return", async () => {
  const opened = jest.spyOn(defaultBrowser, "openDefaultAppsSettings").mockImplementation(async () => undefined);
  const appSettings = jest.spyOn(Linking, "openSettings").mockImplementation(async () => undefined);
  const root = renderSurface(<DefaultBrowserPage />);
  await settle();
  expect(textOf(root)).toContain("How to change your default browser");
  await pressButton(root, "Open Ardia in Settings");
  await settle();
  expect(opened).toHaveBeenCalledTimes(1);
  expect(appSettings).not.toHaveBeenCalled();
  const reads = (defaultBrowser.status as jest.Mock).mock.calls.length;
  status = { isDefault: true, canAsk: true };
  comeBack();
  await settle();
  expect((defaultBrowser.status as jest.Mock).mock.calls.length).toBe(reads + 1);
  expect(useDefaultBrowser.getState().status).toEqual({ isDefault: true, canAsk: true });
  unmount(root);
});

onIos("in onboarding on iPhone, tapping the button moves on as you leave for Settings, as the SwiftUI app does", async () => {
  jest.spyOn(defaultBrowser, "openDefaultAppsSettings").mockImplementation(async () => undefined);
  const done = jest.fn();
  const root = renderSurface(<DefaultBrowserSteps onLater={jest.fn()} onDone={done} />);
  await settle();
  await pressButton(root, "Open Ardia in Settings");
  await settle();
  expect(done).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("on Android nothing changed: without the role on offer the button opens Default Apps and moves on only once Ardia is the default", async () => {
  const opened = jest.spyOn(defaultBrowser, "openDefaultAppsSettings").mockImplementation(async () => undefined);
  const done = jest.fn();
  const root = renderSurface(<DefaultBrowserSteps onLater={jest.fn()} onDone={done} />);
  await settle();
  await pressButton(root, "Open Default Apps");
  await settle();
  expect(opened).toHaveBeenCalledTimes(1);
  expect(done).not.toHaveBeenCalled();
  status = { isDefault: true, canAsk: false };
  comeBack();
  await settle();
  expect(textOf(root)).toContain("Ardia is your default browser");
  unmount(root);
});

test("the title is 28 points bold, and the last step's picture is the app icon, as both apps draw it", async () => {
  const root = renderSurface(<DefaultBrowserPage />);
  await settle();
  const title = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header" && /your default browser/i.test(textOf({ root: node } as never)))[0]!;
  const style = StyleSheet.flatten(title.props.style);
  expect(style.fontSize).toBe(28);
  expect(style.fontWeight).toBe("700");
  expect(root.root.findAll((node) => node.type === AppIcon)).toHaveLength(1);
  unmount(root);
});

test("at accessibility text sizes the steps are a plain numbered list instead of the card", async () => {
  const window = Dimensions.get("window");
  Dimensions.set({ window: { ...window, fontScale: 1.6 }, screen: { ...window, fontScale: 1.6 } });
  const root = renderSurface(<DefaultBrowserPage />);
  await settle();
  const list = root.root.findAll((node) => node.props.testID === "defaultBrowserList" && typeof node.type === "string");
  expect(list).toHaveLength(1);
  expect(textOf({ root: list[0]! } as never)).toMatch(/^1\. /);
  expect(root.root.findAll((node) => node.type === AppIcon)).toHaveLength(0);
  Dimensions.set({ window, screen: window });
  unmount(root);
});

onAndroid("on Android, when nothing on the phone can take the request, onboarding moves on as Compose does", async () => {
  jest.spyOn(defaultBrowser, "openDefaultAppsSettings").mockImplementation(async () => {
    throw new Error("No activity found");
  });
  const later = jest.fn();
  const done = jest.fn();
  const root = renderSurface(<DefaultBrowserSteps onLater={later} onDone={done} />);
  await settle();
  await pressButton(root, "Open Default Apps");
  await settle();
  expect(later).toHaveBeenCalledTimes(1);
  expect(done).not.toHaveBeenCalled();
  unmount(root);
});

test("Settings' own default browser page keeps the shared primary button, not onboarding's ink capsule", async () => {
  const root = renderSurface(<DefaultBrowserPage />);
  await settle();
  expect(root.root.findAll((node) => node.type === PrimaryButton)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === ActionButton && node.props.tone === "ink")).toHaveLength(0);
  unmount(root);
});
