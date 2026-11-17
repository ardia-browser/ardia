import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { readOpenTabs } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

type Listener = (event: { name: string; [key: string]: unknown }) => void;

const listeners: Listener[] = [];
let results: Record<string, unknown>[] = [];

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
  results = [];
  jest.spyOn(pages, "snapshot").mockImplementation(async () => results.shift() as never);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const background = () => currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
const shown = (id: string) => currentTabs().open.find((tab) => tab.id === id)!.snapshotFileName;
const saved = (id: string) => readOpenTabs(browserDatabase()).find((tab) => tab.id === id)!.snapshotFileName;
const capture = (id: string, result: Record<string, unknown>) => {
  results.push({ path: "", width: 400, height: 800, ...result });
  return act(async () => browse.captureSnapshot(id));
};
const land = (id: string, uri: string, generation: number) => act(() => listeners.forEach((listener) => listener({ name: "page.snapshotLanded", pageId: id, uri, generation })));

test("a picture whose file hasn't landed is shown at once but not saved, so a kill before the write never leaves a saved picture with no file; it's saved when native says it landed", async () => {
  const tab = background();
  await capture(tab.id, { uri: "file:///p/a-10.jpg", durable: true, generation: 10 });
  expect(saved(tab.id)).toBe("file:///p/a-10.jpg");
  await capture(tab.id, { uri: "file:///p/a-20.jpg", durable: false, generation: 20 });
  expect(shown(tab.id)).toBe("file:///p/a-20.jpg");
  expect(saved(tab.id)).toBe("file:///p/a-10.jpg");
  land(tab.id, "file:///p/a-20.jpg", 20);
  expect(saved(tab.id)).toBe("file:///p/a-20.jpg");
  expect(shown(tab.id)).toBe("file:///p/a-20.jpg");
});

test("a capture that resolves after a newer one is ignored, and a landing older than one already saved changes nothing", async () => {
  const tab = background();
  await capture(tab.id, { uri: "file:///p/a-30.jpg", durable: false, generation: 30 });
  await capture(tab.id, { uri: "file:///p/a-25.jpg", durable: true, generation: 25 });
  expect(shown(tab.id)).toBe("file:///p/a-30.jpg");
  land(tab.id, "file:///p/a-30.jpg", 30);
  land(tab.id, "file:///p/a-25.jpg", 25);
  expect(saved(tab.id)).toBe("file:///p/a-30.jpg");
  expect(shown(tab.id)).toBe("file:///p/a-30.jpg");
});

test("an older capture that lands while a newer one is still on its way becomes the saved picture, and the newer one stays on screen", async () => {
  const tab = background();
  await capture(tab.id, { uri: "file:///p/a-40.jpg", durable: false, generation: 40 });
  await capture(tab.id, { uri: "file:///p/a-50.jpg", durable: false, generation: 50 });
  land(tab.id, "file:///p/a-40.jpg", 40);
  expect(saved(tab.id)).toBe("file:///p/a-40.jpg");
  expect(shown(tab.id)).toBe("file:///p/a-50.jpg");
  land(tab.id, "file:///p/a-50.jpg", 50);
  expect(saved(tab.id)).toBe("file:///p/a-50.jpg");
});

test("a picture with no durability or generation, as iPhone's capture returns, is shown and saved at once, as before", async () => {
  const tab = background();
  await capture(tab.id, { uri: "file:///p/ios.jpg" });
  expect(shown(tab.id)).toBe("file:///p/ios.jpg");
  expect(saved(tab.id)).toBe("file:///p/ios.jpg");
});
