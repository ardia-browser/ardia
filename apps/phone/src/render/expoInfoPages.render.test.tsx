import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import * as settingsActions from "../state/settings/actions";
import * as defaultBrowser from "../state/settings/defaultBrowser";
import { openSettings, type SettingsRoute } from "../state/settings/nav";
import { PHONE_WHATS_SENT } from "../lib/telemetryCopy";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const open = async (route: SettingsRoute) => {
  openSettings(route);
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const page = root.root.findAll((node) => typeof node.type === "string" && node.props.name === "destination" && (node.props.extraProps as { value?: string } | undefined)?.value === route.page)[0]!;
  return { root, page };
};
const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const texts = (node: ReactTestInstance) => within(node, (props) => typeof props.text === "string").map((inner) => inner.props.text as string);
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));
const done = async (root: Root) => {
  await act(async () => void jest.advanceTimersByTime(1000));
  unmount(root);
};

onIos("Clear Browsing Data is main's form on Expo UI: Time Range, the Clear switches, Archived Tabs only for all time, and Clear Data behind main's confirmation", async () => {
  const clear = jest.spyOn(settingsActions, "clearBrowsingData").mockResolvedValue(undefined as never);
  jest.spyOn(settingsActions, "websiteDataClearsByTime").mockReturnValue(true);
  const { root, page } = await open({ page: "clearData" });
  expect(within(page, (props) => props.label === "Time Range")).toHaveLength(1);
  expect(texts(page)).toEqual(expect.arrayContaining(["History", "Cache", "Cookies and Site Data", "Clear Data…"]));
  expect(texts(page)).not.toContain("Archived Tabs");
  await act(async () => within(page, (props) => props.label === "Time Range")[0]!.props.onSelectionChange({ nativeEvent: { selection: "allTime" } }));
  expect(texts(within(root.root, (props) => props.name === "destination")[0]!)).toContain("Archived Tabs");
  await press(within(root.root, (props) => props.label === "Clear Data")[0]!);
  expect(clear).toHaveBeenCalledTimes(1);
  await done(root);
});

onIos("About Ardia has main's three links with their arrows and Open Source Licenses; Licenses lists each credit with its license and address", async () => {
  const openLink = jest.spyOn(settingsActions, "openFromSettings").mockImplementation(() => undefined);
  const about = await open({ page: "about" });
  expect(texts(about.page)).toEqual(expect.arrayContaining(["Ardia", "ardia.dev", "Release Notes", "Source Code", "Open Source Licenses"]));
  expect(within(about.page, (props) => props.systemName === "arrow.up.forward")).toHaveLength(3);
  await press(within(about.page, (props) => typeof props.onButtonPress === "function" || typeof props.onPress === "function").find((node) => texts(node).includes("Release Notes"))!);
  expect(openLink).toHaveBeenCalledWith("https://ardia.dev/release-notes");
  await done(about.root);
  const licenses = await open({ page: "licenses" });
  expect(texts(licenses.page)).toEqual(expect.arrayContaining(["EasyList", "Public Suffix List", "publicsuffix.org"]));
  expect(within(licenses.page, (props) => props.label === "License").length).toBeGreaterThan(3);
  expect(within(licenses.page, (props) => props.title === "Code in This App")).toHaveLength(1);
  await done(licenses.root);
});

onIos("Default Browser shows main's instructions and steps card with the primary button; What's Sent lists every section", async () => {
  jest.spyOn(defaultBrowser, "refreshDefaultBrowser").mockResolvedValue(null);
  defaultBrowser.useDefaultBrowser.setState({ status: { isDefault: false, canAsk: false, isOffered: true } as never });
  const ask = jest.spyOn(defaultBrowser, "askForDefaultBrowser").mockResolvedValue({ status: null, unavailable: false } as never);
  const browser = await open({ page: "defaultBrowser" });
  const words = texts(browser.page);
  expect(words.some((text) => /^1\. /.test(text))).toBe(true);
  const action = within(browser.page, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string; style?: string }[]).some((modifier) => modifier.$type === "buttonStyle" && modifier.style === "borderedProminent"))[0]!;
  await press(action);
  expect(ask).toHaveBeenCalledTimes(1);
  await done(browser.root);
  const sent = await open({ page: "whatsSent" });
  expect(within(sent.page, (props) => typeof props.title === "string").map((node) => node.props.title)).toEqual(expect.arrayContaining(PHONE_WHATS_SENT.map((section) => section.title)));
  await done(sent.root);
});
