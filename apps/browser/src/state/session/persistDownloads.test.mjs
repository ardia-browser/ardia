import assert from "node:assert/strict";
import { test } from "node:test";
import { docs, removedStagings, stagingRemovals } from "../../test-native/index.ts";
import { flushPersistence, loadSession, resumePersistence, startPersistence } from "./persist.ts";
import { useBrowser } from "../browser/store.ts";
import { useDownloadProgress, withLiveProgress } from "../downloads/progress.ts";
import { takeDownloadWork } from "../telemetry/downloadWork.ts";

const paused = {
  id: "wk-download-1",
  url: "https://a/x",
  filename: "x",
  path: "/d/.ardia-download-1/x",
  state: "failed",
  paused: true,
  received: 1,
  total: 2,
  speed: 0,
  mimeType: "",
  profile: "",
  staging: "/d/.ardia-download-1",
};
const finished = { ...paused, id: "wk-download-2", path: "/d/y", state: "finished", paused: false, staging: null };

function load(downloads, version = 3) {
  docs.set("session.json", JSON.stringify({ version: 2, windows: [], tabs: [] }));
  docs.set("downloads.json", JSON.stringify({ version, downloads }));
  return loadSession();
}

test("a download left paused at quit asks for its staging folder to go, and keeps it named until it has", () => {
  removedStagings.length = 0;
  stagingRemovals.ok = false;
  const data = load([paused, finished]);
  assert.deepEqual(removedStagings, ["/d/.ardia-download-1"]);
  const [left, done] = data.downloads;
  assert.equal(left.staging, "/d/.ardia-download-1");
  assert.equal(left.id, "saved-0");
  assert.ok(!("staging" in done));
  stagingRemovals.ok = true;
});

test("a restored record keeps its staging folder, so the next launch tries again", () => {
  removedStagings.length = 0;
  stagingRemovals.ok = false;
  const data = load([{ ...paused, id: "saved-0" }]);
  assert.deepEqual(removedStagings, ["/d/.ardia-download-1"]);
  assert.equal(data.downloads[0].staging, "/d/.ardia-download-1");
  stagingRemovals.ok = true;
});

test("a version 1 or 2 document drops the staging id and destination it kept beside the staging path", () => {
  for (const version of [1, 2]) {
    removedStagings.length = 0;
    stagingRemovals.ok = false;
    const old = { ...paused, id: "saved-0", stagingId: "1", destination: "/d/x" };
    const data = load([old, { ...finished, destination: "/d/y" }], version);
    assert.deepEqual(removedStagings, ["/d/.ardia-download-1"]);
    const [left, done] = data.downloads;
    assert.equal(left.staging, "/d/.ardia-download-1");
    assert.ok(!("stagingId" in left) && !("destination" in left) && !("destination" in done));
    stagingRemovals.ok = true;
  }
});

const running = { ...paused, id: "running-1", state: "downloading", paused: false, received: 0, total: 200, speed: 0 };

function persisting(run) {
  docs.clear();
  useDownloadProgress.setState({}, true);
  const stop = startPersistence();
  useBrowser.getState().createWindow({ url: "about:blank" });
  flushPersistence();
  takeDownloadWork();
  let notified = 0;
  const unsubscribe = useBrowser.subscribe(() => notified++);
  const report = (patch) => {
    useBrowser.getState().upsertDownload({ ...running, ...patch });
    flushPersistence();
    return docs.get("downloads.json");
  };
  try {
    run(report, () => notified);
  } finally {
    unsubscribe();
    stop();
    resumePersistence();
  }
}

const listed = () => withLiveProgress(useBrowser.getState().downloads).find((d) => d.id === running.id);

test("progress alone wakes no workspace subscriber and leaves downloads.json alone, and the rows still read it", () => {
  persisting((report, notified) => {
    const started = report({});
    const afterStart = notified();
    const records = useBrowser.getState().downloads;
    for (const received of [10, 50, 100]) {
      assert.equal(report({ received, speed: received * 2 }), started, "progress alone must not rewrite the history");
      assert.deepEqual([listed().received, listed().total, listed().speed], [received, 200, received * 2]);
    }
    assert.equal(notified(), afterStart, "progress alone must not notify the workspace store");
    assert.equal(useBrowser.getState().downloads, records);
    assert.deepEqual(takeDownloadWork(), { download_progress_updates: 4, download_history_writes: 1, download_history_kb_written: Math.round(started.length / 1024) });
  });
});

test("pause, danger and a rename still save, with the bytes received so far, and a download running at quit is saved as failed", () => {
  persisting((report) => {
    report({ received: 100, speed: 20 });
    for (const patch of [{ paused: true }, { dangerous: true }, { path: "/d/renamed", filename: "renamed" }]) {
      const saved = JSON.parse(report({ received: 100, speed: 20, ...patch })).downloads[0];
      for (const [key, value] of Object.entries(patch)) assert.equal(saved[key], value);
      assert.deepEqual([saved.state, saved.received, saved.total], ["failed", 100, 200]);
    }
    assert.equal(loadSession().downloads[0].state, "failed");
  });
});

test("a finished download keeps its final size across a relaunch, and its progress is dropped", () => {
  persisting((report) => {
    report({ received: 100, total: 0, speed: 20 });
    report({ state: "finished", path: "/d/done", staging: null, total: 0, received: 12345, speed: 0 });
    assert.deepEqual(useDownloadProgress.getState(), {});
    assert.deepEqual([listed().received, listed().total], [12345, 0]);
    const restored = loadSession().downloads[0];
    assert.deepEqual([restored.state, restored.path, restored.received, restored.total], ["finished", "/d/done", 12345, 0]);
  });
});

test("a download that is removed, cancelled before it has a path or forgotten with its session leaves no progress behind", () => {
  persisting((report) => {
    report({ received: 10 });
    useBrowser.getState().removeDownload(running.id);
    assert.deepEqual(useDownloadProgress.getState(), {});
    report({ received: 20 });
    report({ state: "cancelled", path: "" });
    assert.deepEqual(useDownloadProgress.getState(), {});
    assert.equal(useBrowser.getState().downloads.some((d) => d.id === running.id), false);
    report({ path: "", received: 30 });
    assert.deepEqual(useDownloadProgress.getState(), {}, "a download with no path yet isn't listed, so it has no progress either");
    report({ received: 40, profile: "work" });
    useBrowser.getState().forgetDownloads("work");
    assert.deepEqual(useDownloadProgress.getState(), {});
  });
});

test("quitting saves the bytes a running download has by then, not the ones at its last save", () => {
  persisting((report) => {
    const started = report({ received: 10 });
    assert.equal(report({ received: 150, total: 300, speed: 40 }), started);
    flushPersistence({ final: true });
    const saved = JSON.parse(docs.get("downloads.json")).downloads[0];
    assert.deepEqual([saved.state, saved.received, saved.total], ["failed", 150, 300]);
    assert.deepEqual([loadSession().downloads[0].received, loadSession().downloads[0].total], [150, 300]);
  });
});

test("quitting with no download running, or with nothing new, writes nothing", () => {
  persisting((report) => {
    report({ received: 10 });
    flushPersistence({ final: true });
    resumePersistence();
    takeDownloadWork();
    flushPersistence({ final: true });
    resumePersistence();
    report({ state: "finished", path: "/d/done", received: 20, total: 20 });
    takeDownloadWork();
    flushPersistence({ final: true });
    assert.equal(takeDownloadWork().download_history_writes, 0);
  });
});

test("a download pushed off the end of the list takes its progress with it", () => {
  persisting((report) => {
    for (let i = 0; i <= 100; i++) report({ id: `running-${i}`, received: i + 1 });
    const listed = useBrowser.getState().downloads.map((d) => d.id);
    assert.equal(listed.length, 100);
    assert.equal(listed.includes("running-0"), false);
    assert.deepEqual(Object.keys(useDownloadProgress.getState()).sort(), [...listed].sort());
  });
});
