import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { idOf, itemOf, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { ReaderView } = require("../components/browsing/ReaderView") as typeof import("../components/browsing/ReaderView");
const { SendRow } = require("../components/browsing/PageMenuWords") as typeof import("../components/browsing/PageMenuWords");
const pageActions = require("../state/page/actions") as typeof import("../state/page/actions");
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

test("the Reader's Text Appearance is a tap menu like main's: the two sizes with their symbols, then the fonts, then the themes, each checked", async () => {
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

test("the Reader's size items turn off at the smallest and largest sizes", async () => {
  jest.spyOn(pageActions, "readableContent").mockResolvedValue(ARTICLE as never);
  act(() => usePreferences.setState({ readerStep: 0 } as never));
  const smallest = renderSurface(<ReaderView tabId="t0" />);
  await act(async () => undefined);
  const menu = contextMenus(smallest)[0]!;
  expect(itemOf(items(menu), "Smaller Text")!.disabled).toBe(true);
  expect(itemOf(items(menu), "Larger Text")!.disabled).toBeUndefined();
  unmount(smallest);
});

test("the page menu's Send to Device is a tap menu of the devices with main's symbols, and sends to the one picked", () => {
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
