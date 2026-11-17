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
