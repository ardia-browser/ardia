import { act } from "react-test-renderer";

const core = require("expo-modules-core") as { requireOptionalNativeModule: (name: string) => unknown; requireNativeViewManager: (name: string) => unknown };
const realOptional = core.requireOptionalNativeModule;
const realView = core.requireNativeViewManager;
const { forwardRef, useImperativeHandle, createElement } = require("react") as typeof import("react");
const NativeField = forwardRef(function NativeField(props: Record<string, unknown>, ref) {
  useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }));
  return createElement("ArdiaPhoneCompletingField", props);
});
jest.spyOn(core, "requireOptionalNativeModule").mockImplementation((name: string) => (name === "ArdiaPhoneCompletingField" ? {} : realOptional(name)));
jest.spyOn(core, "requireNativeViewManager").mockImplementation((name: string) => (name === "ArdiaPhoneCompletingField" ? NativeField : realView(name)));

const { SearchTray } = require("../components/search/SearchTray") as typeof import("../components/search/SearchTray");
const { pages } = require("../platform/pages") as typeof import("../platform/pages");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const { history } = require("../state/history/store") as typeof import("../state/history/store");
const { presentSearch } = require("../state/search/store") as typeof import("../state/search/store");
const { currentTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { renderSurface, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

type Listener = (event: { name: string; [key: string]: unknown }) => void;

let listeners: Listener[] = [];
let listening: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  browse.useBrowse.setState({ surface: "browsing" });
  listeners = [];
  listening = jest.spyOn(pages, "addListener").mockImplementation((listener: unknown) => {
    listeners.push(listener as Listener);
    return { remove: () => undefined };
  });
  browse.startBrowser();
});

afterEach(() => {
  listening.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("one Go through the switch component the Android build uses opens exactly one tab, and its page's own report records one visit and no second tab", () => {
  presentSearch("page", "");
  const root = renderSurface(<SearchTray />);
  const field = root.root.findAll((node) => node.type === ("ArdiaPhoneCompletingField" as never))[0]!;
  expect(field).toBeDefined();
  const before = currentTabs().open.length;
  const record = jest.spyOn(history(), "record");
  act(() => field.props.onSubmit({ nativeEvent: { displayed: "example.com" } }));
  act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().open.length).toBe(before + 1);
  const opened = currentTabs().selectedId!;
  act(() => listeners.forEach((listener) => listener({ name: "page.visited", pageId: opened, url: "https://example.com/", title: "Example", kind: "typed" })));
  act(() => listeners.forEach((listener) => listener({ name: "page.state", pageId: opened, state: { url: "https://example.com/", title: "Example", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } })));
  expect(currentTabs().open.length).toBe(before + 1);
  expect(record).toHaveBeenCalledTimes(1);
  record.mockRestore();
  unmount(root);
});

test("a field that reports one Go twice still opens one tab: the tray takes one submit", () => {
  presentSearch("page", "");
  const root = renderSurface(<SearchTray />);
  const field = root.root.findAll((node) => node.type === ("ArdiaPhoneCompletingField" as never))[0]!;
  const before = currentTabs().open.length;
  act(() => {
    field.props.onSubmit({ nativeEvent: { displayed: "example.com" } });
    field.props.onSubmit({ nativeEvent: { displayed: "example.com" } });
  });
  expect(currentTabs().open.length).toBe(before + 1);
  unmount(root);
});

test("each tab opened prints one lab line with its origin, so a phone run can count tabs per submit", () => {
  const lab = require("../platform/lab") as typeof import("../platform/lab");
  const traced: string[] = [];
  lab.traceLab(true, (line) => traced.push(line));
  presentSearch("page", "");
  const root = renderSurface(<SearchTray />);
  const field = root.root.findAll((node) => node.type === ("ArdiaPhoneCompletingField" as never))[0]!;
  act(() => field.props.onSubmit({ nativeEvent: { displayed: "example.com" } }));
  lab.traceLab(false);
  const opened = traced.filter((line) => line.startsWith("PAGELAB tab opened"));
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^PAGELAB tab opened #\d+ origin typed id \S+ open \d+$/);
  unmount(root);
});
