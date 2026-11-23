import { act } from "react-test-renderer";
import { settledWithoutWaiting } from "../state/app/boot";
import * as browserDatabase from "../state/store/browserDatabase";
import { tabDatabase } from "../state/store/database";
import { pages } from "../platform/pages";
import * as pageStore from "../state/pages/store";
import * as telemetry from "../state/telemetry/telemetry";
import { appBecameActive } from "../state/browse/store";
import { ARCHIVE_LIMIT, ARCHIVE_RETENTION_MS, ARCHIVE_SEARCH_LIMIT, archivedTabById, archiveTabById, clearArchivedTabs, currentTabs, deleteArchivedTabsById, flushTabWrites, loadArchive, onTabWritesStalled, pruneExpiredArchive, reserveStateSave, restoreArchivedTab, saveTabState, searchArchive, selectTabById, tabSavedState, tabWritesPending, tabWritesStalled, updateTabById } from "../state/tabs/store";
import { someTabs, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(pages, "close").mockResolvedValue(undefined);
  jest.spyOn(pages, "deleteSnapshots").mockResolvedValue(undefined);
  jest.spyOn(pages, "saveState").mockResolvedValue(null);
  withTabs(3);
  browserDatabase.writeTabs(tabDatabase(), currentTabs().open, []);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const stored = (id: string) => browserDatabase.readOpenTabs(tabDatabase()).find((tab) => tab.id === id)!;

test("a busy database keeps the batch and retries it until the commit lands, so the screen and the store never disagree for long", () => {
  const next = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  const real = jest.requireActual<typeof browserDatabase>("../state/store/browserDatabase").commitTabChanges;
  let refusals = 2;
  jest.spyOn(browserDatabase, "commitTabChanges").mockImplementation((db, commit) => {
    if (refusals > 0) {
      refusals -= 1;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return real(db, commit);
  });
  act(() => selectTabById(next.id));
  act(() => jest.advanceTimersByTime(20));
  expect(tabWritesPending()).toBe(true);
  act(() => jest.advanceTimersByTime(500));
  expect(tabWritesPending()).toBe(false);
  expect(stored(next.id).lastActive).toBe(currentTabs().open.find((tab) => tab.id === next.id)!.lastActive);
});

test("a new address is written at once, while a new title waits for the frame after the change", () => {
  const id = currentTabs().open[0]!.id;
  act(() => updateTabById(id, { url: "https://moved.example/" }));
  expect(stored(id).url).toBe("https://moved.example/");
  act(() => updateTabById(id, { title: "Later" }));
  expect(stored(id).title).not.toBe("Later");
  expect(flushTabWrites()).toBe(true);
  expect(stored(id).title).toBe("Later");
});

test("the import is skipped without waiting only when the native side says it is settled, and a cached none never skips it", () => {
  expect(settledWithoutWaiting("none", null)).toBe("none");
  expect(settledWithoutWaiting("imported", null)).toBe("imported");
  expect(settledWithoutWaiting("startedFresh", "startedFresh")).toBe("startedFresh");
  expect(settledWithoutWaiting("startedFresh", null)).toBeNull();
  expect(settledWithoutWaiting("pending", "imported")).toBeNull();
  expect(settledWithoutWaiting("unknown", "imported")).toBe("imported");
  expect(settledWithoutWaiting("unknown", null)).toBeNull();
});

const refuse = (times: number, message: string) => {
  const real = jest.requireActual<typeof browserDatabase>("../state/store/browserDatabase").commitTabChanges;
  let left = times;
  return jest.spyOn(browserDatabase, "commitTabChanges").mockImplementation((db, commit) => {
    if (left > 0) {
      left -= 1;
      throw new Error(message);
    }
    return real(db, commit);
  });
};

test("Clear Archive covers an archive still waiting on a busy database: once the retry lands the archive stays empty, and the picture files go only after the commit", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const removed = jest.spyOn(pageStore, "deletePageSnapshots");
  const id = currentTabs().open[0]!.id;
  refuse(2, "SQLITE_BUSY: database is locked");
  act(() => archiveTabById(id));
  expect(tabWritesPending()).toBe(true);
  act(() => clearArchivedTabs());
  expect(currentTabs().archivedCount).toBe(0);
  expect(removed.mock.calls.flatMap(([ids]) => ids)).not.toContain(id);
  act(() => jest.advanceTimersByTime(1_000));
  expect(tabWritesPending()).toBe(false);
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10)).toEqual([]);
  expect(browserDatabase.readOpenTabs(tabDatabase()).map((tab) => tab.id)).not.toContain(id);
  expect(removed.mock.calls.flatMap(([ids]) => ids)).toContain(id);
});

test("an archive after Clear Archive in the same waiting batch survives it", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const [first, second] = currentTabs().open;
  refuse(1, "SQLITE_BUSY");
  act(() => archiveTabById(first!.id));
  act(() => clearArchivedTabs());
  act(() => archiveTabById(second!.id));
  act(() => jest.advanceTimersByTime(1_000));
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10).map((tab) => tab.id)).toEqual([second!.id]);
});

test("a write that fails for good stops retrying on a timer and waits for the next change", () => {
  const commits = refuse(100, "SQLITE_FULL: database or disk is full");
  const id = currentTabs().open[0]!.id;
  act(() => updateTabById(id, { url: "https://stuck.example/" }));
  const tries = commits.mock.calls.length;
  act(() => jest.advanceTimersByTime(30_000));
  expect(commits.mock.calls.length).toBe(tries);
  expect(tabWritesStalled()).toBe(true);
  commits.mockRestore();
  act(() => updateTabById(id, { title: "Unstuck" }));
  expect(flushTabWrites()).toBe(true);
  expect(stored(id).url).toBe("https://stuck.example/");
});

test("the picture a committed row points at is handed to the native side only after SQLite commits it", () => {
  const acknowledged = jest.spyOn(pages, "snapshotsCommitted").mockImplementation(() => undefined);
  const id = currentTabs().open[0]!.id;
  refuse(1, "SQLITE_BUSY");
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/b.jpg" }));
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/c.jpg" }));
  act(() => jest.advanceTimersByTime(20));
  expect(acknowledged).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(500));
  expect(acknowledged).toHaveBeenCalledWith({ [id]: "file:///snapshots/c.jpg" });
});

const tick = async () => {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
};

test("while a Clear Archive waits on a busy database the archive stays empty when reloaded or searched, and restoring a row read before the clear does nothing", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const id = currentTabs().open[0]!.id;
  act(() => archiveTabById(id));
  act(() => loadArchive());
  const stale = currentTabs().archive!.find((tab) => tab.id === id)!;
  refuse(2, "SQLITE_BUSY");
  act(() => clearArchivedTabs());
  act(() => loadArchive());
  expect(currentTabs().archive).toEqual([]);
  expect(searchArchive(stale.title).map((tab) => tab.id)).not.toContain(id);
  expect(archivedTabById(id)).toBeNull();
  expect(restoreArchivedTab(stale)).toBe(false);
  act(() => jest.advanceTimersByTime(1_000));
  expect(tabWritesPending()).toBe(false);
  expect(browserDatabase.readOpenTabs(tabDatabase()).map((tab) => tab.id)).not.toContain(id);
  expect(browserDatabase.readArchivedTab(tabDatabase(), id)).toBeNull();
});

test("a restore waiting on a busy database survives a Clear Archive in the same batch, with its picture and navigation state", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const id = currentTabs().open[0]!.id;
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/kept.jpg" }));
  flushTabWrites();
  act(() => archiveTabById(id));
  browserDatabase.writeTabState(tabDatabase(), id, "saved interaction state");
  const removed = jest.spyOn(pageStore, "deletePageSnapshots");
  const acknowledged = jest.spyOn(pages, "snapshotsCommitted").mockImplementation(() => undefined);
  refuse(1, "SQLITE_BUSY");
  act(() => void restoreArchivedTab(archivedTabById(id)!));
  act(() => clearArchivedTabs());
  act(() => jest.advanceTimersByTime(1_000));
  expect(stored(id).snapshotFileName).toBe("file:///snapshots/kept.jpg");
  expect(browserDatabase.readTabState(tabDatabase(), id)).toBe("saved interaction state");
  expect(removed.mock.calls.flatMap(([ids]) => ids)).not.toContain(id);
  expect(acknowledged).toHaveBeenCalledWith(expect.objectContaining({ [id]: "file:///snapshots/kept.jpg" }));
});

test("a page state that resolves after Clear Archive removed its tab writes nothing", async () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  let resolve: (saved: string) => void = () => undefined;
  jest.spyOn(pageStore, "savePageState").mockImplementation(() => new Promise<string | null>((done) => (resolve = done)));
  const id = currentTabs().open[0]!.id;
  act(() => archiveTabById(id));
  act(() => clearArchivedTabs());
  resolve("saved interaction state");
  await act(async () => {
    await tick();
    jest.advanceTimersByTime(50);
  });
  flushTabWrites();
  expect(browserDatabase.readTabState(tabDatabase(), id)).toBeNull();
});

test("writes that stall tell the person once, and are tried again when the app comes back", () => {
  const told = jest.fn();
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  onTabWritesStalled(told);
  const commits = refuse(100, "SQLITE_IOERR: disk I/O error");
  act(() => updateTabById(currentTabs().open[0]!.id, { url: "https://later.example/" }));
  act(() => updateTabById(currentTabs().open[0]!.id, { url: "https://later-still.example/" }));
  expect(told).toHaveBeenCalledTimes(1);
  expect(counted.mock.calls.filter(([name]) => name === "tab_writes_stalled")).toHaveLength(1);
  commits.mockRestore();
  expect(tabWritesPending()).toBe(true);
  act(() => appBecameActive());
  expect(tabWritesPending()).toBe(false);
  onTabWritesStalled(() => undefined);
});

const archivedRows = (count: number) => someTabs(count).map((tab, index) => ({ ...tab, id: `arch${index}`, archivedAt: Date.now() - index }));

for (const pending of [false, true]) {
  test(`a Delete from an Archive row read before its tab was restored leaves the restored tab, its row and its state alone${pending ? ", while the restore still waits on a busy database" : ""}`, () => {
    jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
    const id = currentTabs().open[0]!.id;
    act(() => archiveTabById(id));
    browserDatabase.writeTabState(tabDatabase(), id, "saved interaction state");
    act(() => loadArchive());
    const row = archivedTabById(id)!;
    const removed = jest.spyOn(pageStore, "deletePageSnapshots");
    if (pending) refuse(1, "SQLITE_BUSY");
    expect(restoreArchivedTab(row)).toBe(true);
    expect(deleteArchivedTabsById([row.id])).toBe(0);
    act(() => jest.advanceTimersByTime(1_000));
    expect(currentTabs().open.some((tab) => tab.id === id)).toBe(true);
    expect(stored(id)).toBeDefined();
    expect(browserDatabase.readTabState(tabDatabase(), id)).toBe("saved interaction state");
    expect(removed.mock.calls.flatMap(([ids]) => ids)).not.toContain(id);
  });
}

test("an expired archive row leaves the Archive and its count as soon as it is pruned", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const id = currentTabs().open[0]!.id;
  act(() => archiveTabById(id));
  act(() => loadArchive());
  expect(currentTabs().archive!.map((tab) => tab.id)).toEqual([id]);
  jest.setSystemTime(Date.now() + ARCHIVE_RETENTION_MS + 1);
  act(() => void pruneExpiredArchive());
  act(() => loadArchive());
  expect(currentTabs().archive).toEqual([]);
  expect(currentTabs().archivedCount).toBe(0);
});

test("Archive search matches a waiting row by its new title, not the one the database still has", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const id = currentTabs().open[0]!.id;
  const oldTitle = currentTabs().open[0]!.title;
  act(() => archiveTabById(id));
  act(() => loadArchive());
  refuse(1, "SQLITE_BUSY");
  act(() => updateTabById(id, { title: "New name" }));
  expect(searchArchive(oldTitle).map((tab) => tab.id)).not.toContain(id);
  expect(searchArchive("New name").map((tab) => tab.id)).toEqual([id]);
});

test("a waiting removal doesn't leave the limited Archive search a row short, and the count follows the waiting changes", () => {
  expect(flushTabWrites()).toBe(true);
  const rows = archivedRows(ARCHIVE_SEARCH_LIMIT + 1);
  browserDatabase.writeTabs(tabDatabase(), rows, []);
  const before = browserDatabase.countArchivedTabs(tabDatabase());
  refuse(1, "SQLITE_BUSY");
  act(() => void deleteArchivedTabsById([rows[0]!.id]));

  expect(searchArchive("Site").length).toBe(ARCHIVE_SEARCH_LIMIT);
  act(() => loadArchive());
  expect(currentTabs().archivedCount).toBe(before - 1);
  act(() => jest.advanceTimersByTime(1_000));
  browserDatabase.writeTabs(tabDatabase(), [], rows.map((tab) => tab.id));
});

test("Clear Archive removes hundreds of rows in one commit", () => {
  const rows = archivedRows(1_200);
  browserDatabase.writeTabs(tabDatabase(), rows, []);
  act(() => clearArchivedTabs());
  expect(browserDatabase.countArchivedTabs(tabDatabase())).toBe(0);
});

test("a page state captured before a restore can't overwrite the position saved after it", async () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  let resolve: (saved: string) => void = () => undefined;
  jest.spyOn(pageStore, "savePageState").mockImplementation(() => new Promise<string | null>((done) => (resolve = done)));
  const id = currentTabs().open[0]!.id;
  act(() => archiveTabById(id));
  expect(restoreArchivedTab(archivedTabById(id)!)).toBe(true);
  saveTabState(id, "new position");
  resolve("position before restoring");
  await act(async () => {
    await tick();
    jest.advanceTimersByTime(50);
  });
  flushTabWrites();
  expect(tabSavedState(id)).toBe("new position");
  expect(browserDatabase.readTabState(tabDatabase(), id)).toBe("new position");
});

test("a tab archived again while the database is busy isn't pruned by the old archive date the database still has", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  expect(flushTabWrites()).toBe(true);
  const id = currentTabs().open[0]!.id;
  act(() => archiveTabById(id));
  jest.setSystemTime(Date.now() + ARCHIVE_RETENTION_MS + 1);
  refuse(3, "SQLITE_BUSY");
  expect(restoreArchivedTab(archivedTabById(id)!)).toBe(true);
  act(() => archiveTabById(id));
  act(() => void pruneExpiredArchive());
  act(() => jest.advanceTimersByTime(2_000));
  expect(browserDatabase.readArchivedTab(tabDatabase(), id)).not.toBeNull();
});

test("a page state that lost to a newer one says so, so its scroll position isn't remembered as saved", () => {
  const id = currentTabs().open[0]!.id;
  const older = reserveStateSave(id);
  const newer = reserveStateSave(id);
  expect(saveTabState(id, "at 200", newer)).toBe(true);
  expect(saveTabState(id, "at 100", older)).toBe(false);
  expect(tabSavedState(id)).toBe("at 200");
});

test("at the archive's limit, a restore still waiting on a busy database makes room, so the oldest archived tab isn't pruned; with nothing waiting the tab past the limit is", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  expect(flushTabWrites()).toBe(true);
  browserDatabase.writeTabs(tabDatabase(), [], browserDatabase.readArchivedTabs(tabDatabase(), 10_000).map((tab) => tab.id));
  const rows = archivedRows(ARCHIVE_LIMIT + 1);
  browserDatabase.writeTabs(tabDatabase(), rows, []);
  const oldest = rows[rows.length - 1]!.id;
  refuse(3, "SQLITE_BUSY");
  expect(restoreArchivedTab(archivedTabById(rows[0]!.id)!)).toBe(true);
  expect(pruneExpiredArchive()).toBe(0);
  act(() => jest.advanceTimersByTime(2_000));
  expect(browserDatabase.readArchivedTab(tabDatabase(), oldest)).not.toBeNull();
  browserDatabase.writeTabs(tabDatabase(), [{ ...rows[0]!, archivedAt: Date.now() + 1 }], []);
  expect(pruneExpiredArchive()).toBe(1);
  expect(browserDatabase.readArchivedTab(tabDatabase(), oldest)).toBeNull();
  browserDatabase.writeTabs(tabDatabase(), [], rows.map((tab) => tab.id));
});

test("at the archive's limit, the oldest archived tab is pruned when a tab archived on a busy database pushes it past the limit, even with its own update still waiting", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  expect(flushTabWrites()).toBe(true);
  browserDatabase.writeTabs(tabDatabase(), [], browserDatabase.readArchivedTabs(tabDatabase(), 10_000).map((tab) => tab.id));
  const rows = archivedRows(ARCHIVE_LIMIT);
  browserDatabase.writeTabs(tabDatabase(), rows, []);
  const oldest = rows[rows.length - 1]!.id;
  act(() => loadArchive());
  refuse(3, "SQLITE_BUSY");
  act(() => updateTabById(oldest, { title: "Renamed while busy" }));
  act(() => archiveTabById(currentTabs().open[0]!.id));
  expect(pruneExpiredArchive()).toBe(1);
  act(() => jest.advanceTimersByTime(2_000));
  expect(browserDatabase.readArchivedTab(tabDatabase(), oldest)).toBeNull();
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10_000).length).toBe(ARCHIVE_LIMIT);
  browserDatabase.writeTabs(tabDatabase(), [], browserDatabase.readArchivedTabs(tabDatabase(), 10_000).map((tab) => tab.id));
});

test("when more tabs than the archive holds are archived on a busy database with none committed yet, prune trims the queued tabs to the limit", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  expect(flushTabWrites()).toBe(true);
  browserDatabase.writeTabs(tabDatabase(), [], browserDatabase.readArchivedTabs(tabDatabase(), 10_000).map((tab) => tab.id));
  withTabs(ARCHIVE_LIMIT + 1);
  const ids = currentTabs().open.map((tab) => tab.id);
  const busy = refuse(Number.POSITIVE_INFINITY, "SQLITE_BUSY");
  for (const id of ids) act(() => archiveTabById(id));
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10_000)).toHaveLength(0);
  expect(pruneExpiredArchive()).toBe(1);
  busy.mockRestore();
  expect(flushTabWrites()).toBe(true);
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10_000)).toHaveLength(ARCHIVE_LIMIT);
  browserDatabase.writeTabs(tabDatabase(), [], browserDatabase.readArchivedTabs(tabDatabase(), 10_000).map((tab) => tab.id));
});
