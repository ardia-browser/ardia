import { act } from "react-test-renderer";
import { NO_LAUNCH_ARGUMENTS } from "../lib/launchArguments";
import { pages } from "../platform/pages";
import { runLaunchScenario } from "../state/app/launch";
import * as launchFlags from "../state/app/launchFlags";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("a demo launch takes every open tab's picture offscreen, three at a time as main's warmer does, and keeps each as the tab's snapshot with its title and theme colour", async () => {
  withTabs(5);
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => ({ ...NO_LAUNCH_ARGUMENTS, isDemo: true }));
  const waiting: (() => void)[] = [];
  const asked: string[] = [];
  jest.spyOn(pages, "captureOffscreen").mockImplementation(
    (_url: string, pageId: string) =>
      new Promise((done) => {
        asked.push(pageId);
        waiting.push(() => done({ fileName: `file:///pictures/${pageId}.jpg`, path: `/pictures/${pageId}.jpg`, title: `Loaded ${pageId}`, themeColorHex: "#112233" }));
      }),
  );
  const ids = currentTabs().open.map((tab) => tab.id);
  act(() => runLaunchScenario());
  await act(async () => undefined);
  expect(asked).toEqual(ids.slice(0, 3));
  await act(async () => waiting.splice(0).forEach((done) => done()));
  await act(async () => undefined);
  expect(asked).toEqual(ids);
  await act(async () => waiting.splice(0).forEach((done) => done()));
  for (const tab of currentTabs().open) {
    expect(tab.snapshotFileName).toBe(`file:///pictures/${tab.id}.jpg`);
    expect(tab.title).toBe(`Loaded ${tab.id}`);
    expect(tab.themeColorHex).toBe("#112233");
  }
});
