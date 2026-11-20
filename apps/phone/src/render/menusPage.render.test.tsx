import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { idOf, itemOf, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { ReaderView } = require("../components/browsing/ReaderView") as typeof import("../components/browsing/ReaderView");
const { SendRow } = require("../components/browsing/PageMenuWords") as typeof import("../components/browsing/PageMenuWords");
const pageActions = require("../state/page/actions") as typeof import("../state/page/actions");
const { FloatingMenu } = require("../components/ui") as typeof import("../components/ui");
type MenuItem = import("../components/ui").MenuItem;
const { usePreferences } = require("../state/settings/store") as typeof import("../state/settings/store");

type Root = ReturnType<typeof renderSurface>;

const ARTICLE = { url: "https://news.example/a", title: "A Story", siteName: "News", byline: null, excerpt: null, leadImage: null, language: "en", paragraphs: ["One.", "Two."], html: "", wordCount: 2, isArticle: true };

const MAC = { id: "mac", name: "Studio", kind: "mac", lastSeen: 1, isCurrent: false, canReceiveTabs: true };
const PHONE = { id: "phone", name: "Pixel", kind: "phone", lastSeen: 1, isCurrent: false, canReceiveTabs: true };

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus(true);
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  resetNativeMenus();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const items = (menu: ReactTestInstance): NativeItem[] => menu.props.items;
const choose = (menu: ReactTestInstance, title: string) => act(() => menu.props.onSelect(idOf(menu.props.items, title)));


const nativeTest = Platform.OS === "ios" ? test : test.skip;

nativeTest("the Reader's Text Appearance is a tap menu like main's: the two sizes with their symbols, then the fonts, then the themes, each checked", async () => {
  jest.spyOn(pageActions, "readableContent").mockResolvedValue(ARTICLE as never);
  const step = jest.spyOn(pageActions, "setReaderStep").mockImplementation(() => undefined);
  const serif = jest.spyOn(pageActions, "setReaderSerif").mockImplementation(() => undefined);
  const theme = jest.spyOn(pageActions, "setReaderTheme").mockImplementation(() => undefined);
  act(() => usePreferences.setState({ readerStep: 2, readerSerif: true, readerTheme: "sepia" } as never));
  const root = renderSurface(<ReaderView tabId="t0" />);
  await act(async () => undefined);
  const menu = contextMenus(root).find((node) => node.findAll((child) => child.props.accessibilityLabel === "Text Appearance").length > 0)!;
  expect(menu.props.trigger).toBe("tap");
  expect(menu.props.appearance).toEqual({ dark: false });
  const [serifLabel, sansLabel] = titles((items(menu)[2] as NativeItem).children!) as string[];
  expect(titles(items(menu))).toEqual(["Smaller Text", "Larger Text", { "": [serifLabel, sansLabel] }, { "": ["Light", "Sepia", "Dark"] }]);
  expect(itemOf(items(menu), "Smaller Text")!.systemImage).toBe("textformat.size.smaller");
  expect(itemOf(items(menu), "Larger Text")!.systemImage).toBe("textformat.size.larger");
  expect(itemOf(items(menu), serifLabel!)!.checked).toBe(true);
  expect(itemOf(items(menu), "Sepia")!.checked).toBe(true);
  choose(menu, "Larger Text");
  expect(step).toHaveBeenCalledWith(3);
  choose(menu, sansLabel!);
  expect(serif).toHaveBeenCalledWith(false);
  choose(menu, "Dark");
  expect(theme).toHaveBeenCalledWith("dark");
  unmount(root);
});

nativeTest("the Reader's size items turn off at the smallest and largest sizes", async () => {
  jest.spyOn(pageActions, "readableContent").mockResolvedValue(ARTICLE as never);
  act(() => usePreferences.setState({ readerStep: 0 } as never));
  const smallest = renderSurface(<ReaderView tabId="t0" />);
  await act(async () => undefined);
  const menu = contextMenus(smallest)[0]!;
  expect(itemOf(items(menu), "Smaller Text")!.disabled).toBe(true);
  expect(itemOf(items(menu), "Larger Text")!.disabled).toBeUndefined();
  unmount(smallest);
});

nativeTest("the page menu's Send to Device is a tap menu of the devices with main's symbols, and sends to the one picked", () => {
  const send = jest.spyOn(pageActions, "sendCurrentTab").mockImplementation(() => undefined);
  const root = renderSurface(<SendRow devices={[MAC, PHONE] as never} />);
  const menu = contextMenus(root)[0]!;
  expect(menu.props.trigger).toBe("tap");
  expect(items(menu)).toEqual([
    { id: "0", title: "Studio", systemImage: "laptopcomputer" },
    { id: "1", title: "Pixel", systemImage: "iphone" },
  ]);
  choose(menu, "Pixel");
  expect(send).toHaveBeenCalledWith(PHONE);
  unmount(root);
});

const drawnTest = Platform.OS === "android" ? test : test.skip;
const drawnLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const floatingItems = (root: Root): MenuItem[] => root.root.findAll((node) => node.type === FloatingMenu)[0]!.props.items;

drawnTest("on Android the Reader's Text Appearance opens the drawn menu with the same items, checked, and no system menu", async () => {
  resetNativeMenus(true);
  jest.spyOn(pageActions, "readableContent").mockResolvedValue(ARTICLE as never);
  const theme = jest.spyOn(pageActions, "setReaderTheme").mockImplementation(() => undefined);
  act(() => usePreferences.setState({ readerStep: 2, readerSerif: true, readerTheme: "sepia" } as never));
  const root = renderSurface(<ReaderView tabId="t0" />);
  await act(async () => undefined);
  expect(contextMenus(root)).toHaveLength(0);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Text Appearance" && typeof node.props.onPress === "function")[0]!.props.onPress());
  const labels = drawnLabels(root);
  expect(labels.slice(0, 2)).toEqual(["Smaller Text", "Larger Text"]);
  expect(labels.slice(-3)).toEqual(["Light", "Sepia", "Dark"]);
  const sepia = root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === "Sepia" && typeof node.type === "string")[0]!;
  expect(sepia.props.accessibilityState).toMatchObject({ checked: true });
  act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === "Dark" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(theme).toHaveBeenCalledWith("dark");
  act(() => jest.advanceTimersByTime(500));
  expect(drawnLabels(root)).toEqual([]);
  unmount(root);
});

drawnTest("on Android the page menu's Send to Device opens the drawn menu of the devices beside its row, and sends to the one picked", () => {
  resetNativeMenus(true);
  const send = jest.spyOn(pageActions, "sendCurrentTab").mockImplementation(() => undefined);
  const root = renderSurface(<SendRow devices={[MAC, PHONE] as never} />);
  expect(contextMenus(root)).toHaveLength(0);
  act(() => root.root.findAll((node) => typeof node.props.onPress === "function" && node.props.accessibilityRole === "button")[0]!.props.onPress());
  const items = floatingItems(root) as { label: string; onPress: () => void }[];
  expect(items.map((item) => item.label)).toEqual(["Studio", "Pixel"]);
  act(() => items[1]!.onPress());
  expect(send).toHaveBeenCalledWith(PHONE);
  unmount(root);
});
