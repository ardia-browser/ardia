import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

type Listener = (event: { name: string; [key: string]: unknown }) => void;

const listeners: Listener[] = [];
let saved: string[] = [];

beforeAll(() => {
  jest.spyOn(pages, "addListener").mockImplementation((listener: unknown) => {
    listeners.push(listener as Listener);
    return { remove: () => undefined };
  });
  browse.startBrowser();
});

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  saved = [];
  jest.spyOn(pages, "saveState").mockImplementation(async (id: string) => {
    saved.push(id);
    return "state" as never;
  });
  jest.spyOn(pages, "scrollPosition").mockImplementation(async () => null as never);
  jest.spyOn(pages, "ids").mockImplementation(async () => currentTabs().open.map((tab) => tab.id) as never);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const send = (event: { name: string; [key: string]: unknown }) => act(() => listeners.forEach((listener) => listener(event)));

test("going back a page on the selected tab saves its session within the save delay, so a relaunch reopens the page Back went to, not the one it left", async () => {
  const tab = currentTabs().open.find((candidate) => candidate.id === currentTabs().selectedId)!;
  send({ name: "page.visited", pageId: tab.id, url: "https://example.com/earlier", title: "Earlier", kind: "backForward" });
  await act(async () => {
    jest.advanceTimersByTime(1600);
  });
  expect(saved).toContain(tab.id);
});

test("going to the background saves every live page's session at once, so a kill right after Back loses nothing", async () => {
  const tab = currentTabs().open.find((candidate) => candidate.id === currentTabs().selectedId)!;
  send({ name: "page.visited", pageId: tab.id, url: "https://example.com/earlier", title: "Earlier", kind: "backForward" });
  await act(async () => {
    browse.appWillResignActive();
  });
  await act(async () => undefined);
  expect(saved).toContain(tab.id);
});
