import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { startPageUi } from "../state/page/actions";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

type Listener = (event: { name: string; [key: string]: unknown }) => void;

const listeners: Listener[] = [];
let adopted: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  adopted = [];
  jest.spyOn(pages, "addListener").mockImplementation((listener: unknown) => {
    listeners.push(listener as Listener);
    return { remove: () => undefined } as never;
  });
  jest.spyOn(pages, "openPopup").mockImplementation(async (pageId: string) => {
    adopted.push(pageId);
    return true;
  });
  browse.startBrowser();
  startPageUi();
  withTabs(3);
  jest.setSystemTime(Math.max(...currentTabs().open.map((tab) => tab.lastActive)) + 60_000);
  browse.useBrowse.setState({ surface: "browsing" });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const popup = async (fields: Record<string, unknown>) => {
  const opener = currentTabs().selectedId!;
  await act(async () => {
    listeners.forEach((listener) => listener({ name: "page.popup", pageId: opener, popupId: "popup-1", url: "https://otter.example/", isUserGesture: true, isPrivate: false, ...fields }));
  });
  return opener;
};

const newest = (before: readonly string[]) => currentTabs().open.find((tab) => !before.includes(tab.id))!;

test("a link the page opens in the background becomes a tab beside its opener, its page is adopted, and the opener stays selected", async () => {
  const before = currentTabs().open.map((tab) => tab.id);
  const opener = await popup({ inBackground: true });
  const opened = newest(before);
  expect(currentTabs().open).toHaveLength(before.length + 1);
  expect(adopted).toEqual([opened.id]);
  expect(currentTabs().selectedId).toBe(opener);
  expect(opened.url).toBe("https://otter.example/");
});

test("a popup without the flag, or with it false, opens in front as before", async () => {
  const before = currentTabs().open.map((tab) => tab.id);
  await popup({});
  const first = newest(before);
  expect(currentTabs().selectedId).toBe(first.id);
  const after = currentTabs().open.map((tab) => tab.id);
  await popup({ inBackground: false, popupId: "popup-2" });
  expect(currentTabs().selectedId).toBe(newest(after).id);
});
