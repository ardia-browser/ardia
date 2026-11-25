import { act } from "react-test-renderer";
import { openTab, useBrowse } from "../state/browse/store";
import { openRemote } from "../state/sync/actions";
import { currentTabs, updateTabById } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { withTabs } from "../../test/render/harness";

jest.mock("../state/pages/store", () => ({ ...jest.requireActual("../state/pages/store"), endPages: () => undefined, deletePageSnapshots: () => undefined }));

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  act(() => useBrowse.setState({ surface: "start", sheet: null }));
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const MUSIC = "https://music.apple.com/";

const tapTile = () => act(() => openRemote(MUSIC, "Music", null, "music"));

test("a pinned tile goes back to the tab it opened after the page has moved off the pinned address, and opens no second copy", () => {
  tapTile();
  const opened = currentTabs().open.find((tab) => tab.pinnedKey === "music")!;
  expect(opened).toMatchObject({ url: MUSIC, origin: "sync" });
  expect(currentTabs().open).toHaveLength(3);
  act(() => void updateTabById(opened.id, { url: "https://music.apple.com/new", title: "New" }));
  act(() => openTab("t0"));
  expect(currentTabs().selectedId).toBe("t0");
  tapTile();
  expect(currentTabs().open).toHaveLength(3);
  expect(currentTabs().selectedId).toBe(opened.id);
  expect(counted).toHaveBeenCalledWith("pinned_tabs_refound");
});

test("back on its own address it is found the same way, and that is not counted", () => {
  tapTile();
  const opened = currentTabs().selectedId;
  act(() => openTab("t0"));
  tapTile();
  expect(currentTabs().open).toHaveLength(3);
  expect(currentTabs().selectedId).toBe(opened);
  expect(counted).not.toHaveBeenCalledWith("pinned_tabs_refound");
});

test("a tile takes over a tab already on its address, and keeps it once that tab moves on", () => {
  act(() => void updateTabById("t1", { url: MUSIC }));
  tapTile();
  expect(currentTabs().open).toHaveLength(2);
  expect(currentTabs().open.find((tab) => tab.id === "t1")!.pinnedKey).toBe("music");
  act(() => void updateTabById("t1", { url: "https://music.apple.com/new" }));
  act(() => openTab("t0"));
  tapTile();
  expect(currentTabs().open).toHaveLength(2);
  expect(currentTabs().selectedId).toBe("t1");
});

test("a row with no key, a Mac's open tab, still opens a new tab once no tab is on its address", () => {
  act(() => openRemote(MUSIC, "Music", null));
  const first = currentTabs().selectedId!;
  act(() => void updateTabById(first, { url: "https://music.apple.com/new" }));
  act(() => openRemote(MUSIC, "Music", null));
  expect(currentTabs().open).toHaveLength(4);
});
