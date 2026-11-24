import { act } from "react-test-renderer";
import { ClearDataPage } from "../components/settings/DataPages";
import { pages } from "../platform/pages";
import { clearBrowsingData } from "../state/settings/actions";
import { textOf, renderSurface, unmount, withTabs, pressButton } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const footerText = (root: ReturnType<typeof renderSurface>) => textOf(root);

test("where website data can't be cleared by time, Clear Browsing Data says cookies and cache clear from all time, on the page and in its confirmation", async () => {
  const byTime = jest.spyOn(pages, "clearsWebsiteDataSince").mockImplementation(() => false);
  const root = renderSurface(<ClearDataPage />);
  const cookies = root.root.findAll((node) => node.props.accessibilityLabel === "Cookies and Site Data" && typeof node.props.onPress === "function")[0]!;
  act(() => cookies.props.onPress());
  expect(footerText(root)).toContain("This phone can only clear the cache and cookies and site data entirely, so they clear from all time.");
  await pressButton(root, "Clear Data");
  expect(textOf(root)).toContain("Clear History from today, and Cache and Cookies from all time?");
  byTime.mockRestore();
  unmount(root);
});

test("where it can, the page keeps the range for everything and says nothing more", async () => {
  const byTime = jest.spyOn(pages, "clearsWebsiteDataSince").mockImplementation(() => true);
  const root = renderSurface(<ClearDataPage />);
  expect(footerText(root)).not.toContain("entirely");
  await pressButton(root, "Clear Data");
  expect(textOf(root)).toContain("Clear History and Cache from today?");
  byTime.mockRestore();
  unmount(root);
});

test("clearing from today passes today's start to the website-data clear, so iPhone honours the range", async () => {
  const cleared = jest.spyOn(pages, "clearWebsiteData").mockImplementation(async () => undefined);
  const now = new Date(2026, 10, 15, 14, 30).getTime();
  jest.setSystemTime(now);
  await act(async () => {
    await clearBrowsingData({ history: false, cache: true, cookies: false, archive: false }, "today");
  });
  expect(cleared).toHaveBeenCalledWith(["cache"], new Date(2026, 10, 15).getTime());
  cleared.mockClear();
  await act(async () => {
    await clearBrowsingData({ history: false, cache: true, cookies: false, archive: false }, "allTime");
  });
  expect(cleared).toHaveBeenCalledWith(["cache"], null);
  cleared.mockRestore();
});

test("clearing history forgets Night Shade's remembered verdicts from the same range, since a list of hosts is history", async () => {
  const forgot = jest.spyOn(pages, "forgetNightShadeVerdicts").mockImplementation(async () => undefined);
  const now = new Date(2026, 10, 15, 14, 30).getTime();
  jest.setSystemTime(now);
  await act(async () => {
    await clearBrowsingData({ history: true, cache: false, cookies: false, archive: false }, "today");
  });
  expect(forgot).toHaveBeenCalledWith(new Date(2026, 10, 15).getTime());
  forgot.mockClear();
  await act(async () => {
    await clearBrowsingData({ history: false, cache: true, cookies: false, archive: false }, "allTime");
  });
  expect(forgot).not.toHaveBeenCalled();
  forgot.mockRestore();
});

test("Clear Data asks in the drawn confirmation card, as iPhone's SwiftUI confirmation does, not the centred dialog", async () => {
  const { ConfirmDialog, ConfirmSheet } = require("../components/ui") as typeof import("../components/ui");
  const byTime = jest.spyOn(pages, "clearsWebsiteDataSince").mockImplementation(() => true);
  const root = renderSurface(<ClearDataPage />);
  await pressButton(root, "Clear Data");
  expect(root.root.findAll((node) => node.type === ConfirmSheet)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === ConfirmDialog)).toHaveLength(0);
  byTime.mockRestore();
  unmount(root);
});

test("a cancelled Clear Data confirmation gives TalkBack focus back to the Clear Data row that opened it once the card has gone; confirming doesn't", async () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const { ButtonRow } = require("../components/settings/SettingsKit") as typeof import("../components/settings/SettingsKit");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const byTime = jest.spyOn(pages, "clearsWebsiteDataSince").mockImplementation(() => true);
  const opener = { clearDataRow: true };
  const restored = () => asked.mock.calls.filter(([target]) => target() === opener).length;
  const root = renderSurface(<ClearDataPage />);
  const ask = () => {
    const row = root.root.findAll((node) => node.type === ButtonRow && node.props.title === "Clear Data…")[0]!;
    act(() => row.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: opener, nativeEvent: {} }));
    expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet")).not.toHaveLength(0);
  };
  const through = () => {
    act(() => jest.advanceTimersByTime(1000));
    act(() => jest.advanceTimersByTime(32));
  };
  ask();
  through();
  expect(restored()).toBe(0);
  act(() => root.root.findAll((node) => node.props.testID === "drawnConfirmationOutside" && typeof node.props.onPress === "function")[0]!.props.onPress());
  through();
  expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet")).toHaveLength(0);
  expect(restored()).toBe(1);
  asked.mockClear();
  ask();
  act(() => root.root.findAll((node) => node.props.accessibilityRole === "button" && node.props.accessibilityLabel === "Clear Data" && typeof node.props.onPress === "function")[0]!.props.onPress());
  through();
  expect(restored()).toBe(0);
  byTime.mockRestore();
  unmount(root);
});
