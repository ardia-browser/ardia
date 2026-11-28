import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { forgetRunningDownloads, noteDownloadEnded, noteDownloadsReported, noteDownloadStarted, useRunningDownloads } from "./running.ts";
import { anyPrivate, cancelDownloadLabel, combinedProgress, DOWNLOAD_INDICATOR_DELAY_MS, indicatorLabel, rowFraction, runningDetail } from "./runningRules.ts";

const row = (bytes: number, total: number | null, fraction: number | null = null) => ({ bytes, total, fraction });

test("the ring shows one download's share, several downloads' combined bytes, and spins when any size is unknown", () => {
  assert.equal(combinedProgress([row(45, 100, 0.45)]), 0.45);
  assert.equal(combinedProgress([row(50, 100), row(150, 300)]), 0.5);
  assert.equal(combinedProgress([row(50, 100), row(10, null)]), null);
  assert.equal(combinedProgress([]), null);
  assert.equal(rowFraction(row(30, 60)), 0.5);
  assert.equal(rowFraction(row(30, null)), null);
});

test("the ring is spoken as Downloads, how many are running and the share in steps of ten, so it updates politely", () => {
  assert.equal(indicatorLabel(1, 0.456), "Downloads, 1 in progress, 40%");
  assert.equal(indicatorLabel(2, 0.5), "Downloads, 2 in progress, 50%");
  assert.equal(indicatorLabel(2, null), "Downloads, 2 in progress");
});

test("a running download's row says how far it is, what it waits for, or what it has so far", () => {
  assert.equal(runningDetail({ ...row(1_200_000, 2_700_000, 0.444), isQueued: false }), "44% · 1.2 MB of 2.7 MB");
  assert.equal(runningDetail({ ...row(0, null), isQueued: true }), "Waiting");
  assert.equal(runningDetail({ ...row(0, null), isQueued: false }), "Downloading…");
  assert.equal(runningDetail({ ...row(512_000, null), isQueued: false }), "512 KB so far");
  assert.equal(cancelDownloadLabel("otter.pdf"), "Cancel otter.pdf");
});

test("the ring waits 800 ms after a download starts, so a fast one shows nothing, and goes once nothing runs", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    forgetRunningDownloads();
    noteDownloadStarted("1", "a.pdf", false, 100, 0);
    assert.equal(useRunningDownloads.getState().indicatorShown, false);
    mock.timers.tick(DOWNLOAD_INDICATOR_DELAY_MS - 1);
    assert.equal(useRunningDownloads.getState().indicatorShown, false);
    noteDownloadEnded("1");
    mock.timers.tick(10);
    assert.equal(useRunningDownloads.getState().indicatorShown, false);
    noteDownloadStarted("2", "b.pdf", false, 100, Date.now());
    mock.timers.tick(DOWNLOAD_INDICATOR_DELAY_MS);
    assert.equal(useRunningDownloads.getState().indicatorShown, true);
    noteDownloadsReported([{ id: "2", fileName: "b.pdf", bytes: 40, total: 100, fraction: 0.4, isQueued: false }], Date.now());
    assert.deepEqual(useRunningDownloads.getState().running.map((item) => [item.id, item.bytes, item.isPrivate]), [["2", 40, false]]);
    noteDownloadsReported([], Date.now());
    assert.deepEqual(useRunningDownloads.getState(), { running: [], indicatorShown: false });
  } finally {
    forgetRunningDownloads();
    mock.timers.reset();
  }
});

test("a download the system reports before the page names it keeps its first sighting and learns whether it is private", () => {
  forgetRunningDownloads();
  noteDownloadsReported([{ id: "7", fileName: "c.zip", bytes: 0, total: null, fraction: null, isQueued: true }], 1000);
  noteDownloadStarted("7", "c.zip", true, 500, 1500);
  const [only] = useRunningDownloads.getState().running;
  assert.equal(only!.firstSeen, 1000);
  assert.equal(only!.isPrivate, true);
  assert.equal(anyPrivate(useRunningDownloads.getState().running), true);
  forgetRunningDownloads();
});
