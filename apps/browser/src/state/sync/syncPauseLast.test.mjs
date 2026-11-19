import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, docOnDisk, pausedStart, quit, retire, settle, shell, stub, syncedProfile, syncNative, timersRun } from "./fixtures/pausedSync.mjs";

const { syncFiles } = await import("./syncFiles.ts");
const { emptyDoc } = await import("./syncDoc.ts");

const documents = shell.shellNativeModules.ArdiaDocuments;
const stockSave = documents.saveDocument;
const stockWrite = documents.writeDocument;
const ui = (engine) => engine.useSync.getState();
const hold = () => Promise.withResolvers();
const snapshot = () => new Map(shell.docs);
const ordinaryStart = (disk, options = {}) => pausedStart(disk, { recoveredStart: false, ...options });
const restoreDocuments = () => Object.assign(documents, { saveDocument: stockSave, writeDocument: stockWrite });

test("Stop saves the disabled document before it forgets the key or clears anything, behind a pause write still in flight", async () => {
  const { disk } = await syncedProfile();
  const held = hold();
  const events = [];
  const engine = await pausedStart(disk, {
    before: () => {
      documents.saveDocument = async (name, value) => {
        if (name === "sync.json") {
          const { enabled, pausedByGuard } = JSON.parse(value);
          events.push(enabled ? (pausedByGuard ? "save paused" : "save enabled") : "save off");
          if (pausedByGuard && events.length === 1) await held.promise;
        }
        return stockSave(name, value);
      };
      const forget = syncNative.forget;
      syncNative.forget = async (...args) => (events.push("forget"), forget(...args));
    },
  });
  try {
    assert.equal(ui(engine).status, "paused");
    const stateBefore = shell.docs.get("sync-state.nns");
    const stop = engine.stopSync();
    await settle();
    assert.deepEqual(events, ["save paused"], "nothing more until the pause write is acknowledged");
    assert.equal(shell.docs.get("sync-state.nns"), stateBefore, "the checkpoint is still there");
    held.resolve();
    await stop;
    await settle();
    assert.deepEqual(events.slice(0, 3), ["save paused", "save off", "forget"]);
    assert.equal(docOnDisk().enabled, false);
    assert.equal(docOnDisk().pausedByGuard, undefined);
    const next = await ordinaryStart(snapshot());
    assert.equal(ui(next).status, "off");
  } finally {
    restoreDocuments();
  }
});

test("the quit's sync save waits for the sync.json queue to drain, while paused too", async () => {
  const { disk } = await syncedProfile();
  const held = hold();
  await pausedStart(disk, {
    before: () => {
      documents.saveDocument = async (name, value) => {
        if (name === "sync.json" && JSON.parse(value).pausedByGuard) await held.promise;
        return stockSave(name, value);
      };
    },
  });
  try {
    quit.setQuitting(true);
    let done = false;
    const quitting = quit.finishQuitSaves(5_000).then(() => (done = true));
    await settle();
    assert.equal(done, false, "the quit waits for the pause write");
    held.resolve();
    await quitting;
    assert.equal(docOnDisk().pausedByGuard, true);
  } finally {
    restoreDocuments();
  }
});

test("Stop during an ordinary start's load waits for it, then runs the retiring cycle", async () => {
  const { disk } = await syncedProfile();
  const load = hold();
  const engine = await ordinaryStart(disk, {
    before: () => {
      const open = syncNative.openLocal;
      syncNative.openLocal = async (value) => {
        await load.promise;
        return open(value);
      };
    },
  });
  assert.equal(ui(engine).status, "starting");
  let stopped = false;
  const stop = engine.stopSync().then(() => (stopped = true));
  await settle();
  assert.equal(stopped, false, "Stop waits for the load");
  assert.equal(calls.forget, 0);
  load.resolve();
  await stop;
  assert.equal(ui(engine).status, "off");
  assert.ok(calls.chainStatus >= 1, "the retiring cycle ran");
  assert.ok(calls.write > 0, "and told the other devices this one left");
});

test("a load that failed is retried by Sync Now, once per press, and not by the timer", async () => {
  const { disk } = await syncedProfile();
  let failures = 1;
  let opens = 0;
  const engine = await ordinaryStart(disk, {
    before: () => {
      const open = syncNative.openLocal;
      syncNative.openLocal = async (value) => {
        opens++;
        if (failures > 0) {
          failures--;
          throw new Error("transient state read failure");
        }
        return open(value);
      };
    },
  });
  assert.equal(ui(engine).status, "stalled");
  const attempts = opens;
  await timersRun();
  assert.equal(opens, attempts, "the timer doesn't retry the load");
  assert.equal(calls.chainStatus, 0);
  await engine.syncNow();
  assert.ok(opens > attempts, "Sync Now loads again");
  assert.equal(calls.chainStatus, 1, "and cycles once it loaded");
  assert.equal(ui(engine).status, "updated");
  const loaded = opens;
  await engine.syncNow();
  assert.equal(opens, loaded, "a loaded state isn't loaded again");
  await retire(engine);
});

test("a Resume whose corrective write hangs still ends paused, so Stop is offered", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const held = hold();
  let cleared = false;
  documents.saveDocument = (name, value) => {
    if (name !== "sync.json") return stockSave(name, value);
    if (!JSON.parse(value).pausedByGuard && JSON.parse(value).enabled) {
      cleared = true;
      return Promise.reject(new Error("clear write refused"));
    }
    if (cleared) return held.promise.then(() => stockSave(name, value));
    return stockSave(name, value);
  };
  try {
    let finished = false;
    const resume = engine.resumeSync().then(() => (finished = true));
    await settle();
    assert.ok(cleared);
    assert.equal(finished, true, "Resume doesn't wait for the corrective write");
    assert.equal(ui(engine).status, "paused");
    held.resolve();
    await resume;
    await settle();
    assert.equal(docOnDisk().pausedByGuard, true);
  } finally {
    restoreDocuments();
  }
});

for (const failure of ["false", "throw"]) {
  test(`a plain sync.json write that is refused (${failure}) clears the cache, so the same payload is written again`, async () => {
    shell.docs.clear();
    const doc = { ...emptyDoc(), enabled: true, seqs: { app: 8 } };
    const files = syncFiles(() => doc);
    const pending = hold();
    let plain = 0;
    documents.saveDocument = (name, value) => pending.promise.then(() => stockSave(name, value));
    documents.writeDocument = (name, value) => {
      plain++;
      if (plain === 1) {
        if (failure === "false") return false;
        throw new Error("plain bridge threw");
      }
      return stockWrite(name, value);
    };
    try {
      doc.seqs = { app: 9 };
      const awaited = files.saveDocNow();
      await settle();
      doc.seqs = { app: 10 };
      files.save();
      pending.resolve();
      await awaited;
      await settle();
      assert.equal(docOnDisk().seqs.app, 9, "the deferred plain write was refused");
      files.save();
      await settle();
      assert.equal(docOnDisk().seqs.app, 10, "the same payload goes out again");
    } finally {
      restoreDocuments();
    }
  });
}

test("a plain write refused outside the queue is retried with the same payload too", () => {
  shell.docs.clear();
  const doc = { ...emptyDoc(), enabled: true, seqs: { app: 4 } };
  const files = syncFiles(() => doc);
  let first = true;
  documents.writeDocument = (name, value) => {
    if (first) {
      first = false;
      return false;
    }
    return stockWrite(name, value);
  };
  try {
    files.save();
    assert.equal(shell.docs.get("sync.json"), undefined);
    files.save();
    assert.equal(docOnDisk().seqs.app, 4);
  } finally {
    restoreDocuments();
  }
});

test("an unlock that comes back after the quit began loads nothing", async () => {
  const { disk } = await syncedProfile();
  const unlock = hold();
  await ordinaryStart(disk, { before: () => void (syncNative.unlock = () => unlock.promise) });
  assert.equal(docOnDisk().unsettledStarts, 1);
  quit.setQuitting(true);
  await quit.finishQuitSaves(3_000);
  assert.equal(docOnDisk().unsettledStarts, 0);
  unlock.resolve(true);
  await settle();
  assert.equal(calls.openLocal, 0, "the saved state isn't opened in a process that is ending");
  assert.equal(docOnDisk().unsettledStarts, 0);
  assert.equal(stub.timers.filter(({ ms }) => ms === 120_000).length, 0);
});
