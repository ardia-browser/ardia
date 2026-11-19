import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, docOnDisk, folder, pausedStart, quit, retire, S, settle, shell, stub, syncedProfile, syncNative, timersRun } from "./fixtures/pausedSync.mjs";

const { syncFiles } = await import("./syncFiles.ts");
const { emptyDoc } = await import("./syncDoc.ts");

const stockNativeRead = syncNative.read;
const documents = shell.shellNativeModules.ArdiaDocuments;
const stockSave = documents.saveDocument;
const stockRead = documents.readDocument;
const stockWrite = documents.writeDocument;
const ui = (engine) => engine.useSync.getState();
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const restoreDocuments = () => Object.assign(documents, { saveDocument: stockSave, readDocument: stockRead, writeDocument: stockWrite });
const settleTimers = () => stub.timers.filter(({ ms }) => ms === 120_000);
const ordinaryStart = (disk, options = {}) => pausedStart(disk, { recoveredStart: false, ...options });
const isClear = (value) => JSON.parse(value).enabled && !JSON.parse(value).pausedByGuard;

test("an old acknowledgement can't make a later sync.json save look unchanged", async () => {
  shell.docs.clear();
  const doc = { ...emptyDoc(), enabled: true, deviceId: "one", seqs: { app: 8 }, pausedByGuard: true };
  const files = syncFiles(() => doc);
  const held = defer();
  documents.saveDocument = async (name, value) => {
    await stockSave(name, value);
    await held.promise;
  };
  try {
    const older = files.saveDocNow();
    await settle();
    doc.seqs = { app: 9 };
    files.save();
    held.resolve();
    await older;
    await settle();
    assert.equal(docOnDisk().seqs.app, 9);
    doc.seqs = { app: 8 };
    files.save();
    await settle();
    assert.equal(docOnDisk().seqs.app, 8, "the later save is written");
  } finally {
    restoreDocuments();
  }
});

test("a plain save issued while an awaited one is in flight is written after it, with the payload of its own turn", async () => {
  shell.docs.clear();
  const doc = { ...emptyDoc(), enabled: true, deviceId: "one", seqs: { app: 1 } };
  const files = syncFiles(() => doc);
  const held = defer();
  const order = [];
  documents.saveDocument = async (name, value) => {
    order.push(["save", JSON.parse(value).seqs.app]);
    await held.promise;
    return stockSave(name, value);
  };
  documents.writeDocument = (name, value) => {
    if (name === "sync.json") order.push(["write", JSON.parse(value).seqs.app]);
    return stockWrite(name, value);
  };
  try {
    const awaited = files.saveDocNow();
    await settle();
    doc.seqs = { app: 2 };
    files.save();
    doc.seqs = { app: 3 };
    await settle();
    assert.deepEqual(order, [["save", 1]], "the plain save waits");
    held.resolve();
    await awaited;
    await settle();
    assert.deepEqual(order, [["save", 1], ["write", 3]]);
    assert.equal(docOnDisk().seqs.app, 3);
  } finally {
    restoreDocuments();
  }
});

test("while the clear is being written the guard stays closed, and the edit refused then isn't lost", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const held = defer();
  let holding = false;
  documents.saveDocument = async (name, value) => {
    if (name === "sync.json" && isClear(value) && !holding) {
      holding = true;
      await held.promise;
    }
    return stockSave(name, value);
  };
  try {
    const resume = engine.resumeSync();
    await settle();
    assert.ok(holding);
    assert.equal(ui(engine).status, "resuming");
    const checks = calls.chainStatus;
    engine.setTypeSynced("history", false);
    await engine.syncNow();
    assert.equal(calls.chainStatus, checks, "no cycle while the clear is written");
    assert.equal(ui(engine).types.history, true, "the edit is refused");
    held.resolve();
    await resume;
    assert.equal(ui(engine).status, "updated");
    assert.equal(docOnDisk().types.history, true);
    assert.equal(docOnDisk().pausedByGuard, undefined);
  } finally {
    restoreDocuments();
  }
  await retire(engine);
});

test("a clear that was refused but still landed is overwritten, so the next start is paused", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  documents.saveDocument = (name, value) => {
    if (name === "sync.json" && isClear(value)) {
      Map.prototype.set.call(shell.docs, name, value);
      return Promise.reject(new Error("transient sharing violation"));
    }
    return stockSave(name, value);
  };
  try {
    await engine.resumeSync();
    await settle();
  } finally {
    restoreDocuments();
  }
  assert.equal(ui(engine).status, "paused");
  assert.equal(docOnDisk().pausedByGuard, true, "the paused document is written again");
  const next = await ordinaryStart(new Map(shell.docs));
  assert.equal(ui(next).status, "paused");
  assert.equal(calls.unlock, 0);
});

test("no cycle runs before the saved state is loaded, whatever asks for one", async () => {
  const { disk } = await syncedProfile();
  const held = defer();
  const engine = await ordinaryStart(disk, {
    before: () => {
      documents.saveDocument = async (name, value) => {
        if (name === "sync.json" && JSON.parse(value).unsettledStarts === 1) await held.promise;
        return stockSave(name, value);
      };
    },
  });
  try {
    await engine.syncNow();
    S().addBookmark({ profileId: "default", url: "https://during-start.example/", title: "During" });
    await timersRun();
    assert.equal(calls.chainStatus, 0);
    assert.equal(calls.write, 0, "nothing reaches the sync folder");
    held.resolve();
    await settle();
    assert.ok(calls.openLocal > 0, "the state loads");
    await engine.syncNow();
    assert.equal(calls.chainStatus, 1, "and cycles run after it");
  } finally {
    restoreDocuments();
  }
});

test("a quit that begins during the Resume's last scope keeps the pause", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const held = defer();
  let late = false;
  syncNative.read = async (...args) => {
    if (args[1] !== "app") {
      late = true;
      await held.promise;
    }
    return stockNativeRead(...args);
  };
  const resume = engine.resumeSync();
  await settle();
  assert.ok(late);
  quit.setQuitting(true);
  const quitting = quit.finishQuitSaves(3_000);
  await settle();
  held.resolve();
  await resume;
  await quitting;
  assert.equal(ui(engine).status, "paused");
  assert.equal(docOnDisk().pausedByGuard, true);
});

test("a Resume released after the quit's deadline doesn't clear the pause", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const held = defer();
  syncNative.read = async (...args) => {
    if (args[1] !== "app") await held.promise;
    return stockNativeRead(...args);
  };
  const resume = engine.resumeSync();
  await settle();
  quit.setQuitting(true);
  const quitting = quit.finishQuitSaves(3_000);
  await settle();
  stub.timers.find(({ ms }) => ms === 3_000).fn();
  const result = await quitting;
  assert.ok(result.unfinished.includes("sync"));
  held.resolve();
  await resume;
  await settle();
  assert.equal(ui(engine).status, "paused");
  assert.equal(docOnDisk().pausedByGuard, true);
});

test("the quit checkpoints before it settles the count, so a crash in the checkpoint stays counted", async () => {
  const { disk } = await syncedProfile();
  const engine = await ordinaryStart(disk);
  assert.ok(calls.openLocal > 0);
  assert.equal(docOnDisk().unsettledStarts, 1);
  const held = defer();
  let sealing = false;
  const seal = syncNative.sealLocal;
  syncNative.sealLocal = async (text) => {
    if (text.startsWith('{"covers":')) {
      sealing = true;
      await held.promise;
    }
    return seal(text);
  };
  quit.setQuitting(true);
  const quitting = quit.finishQuitSaves(5_000);
  await settle();
  assert.ok(sealing, "the checkpoint is under way");
  assert.equal(docOnDisk().unsettledStarts, 1, "and the count is still on disk");
  held.resolve();
  await quitting;
  assert.equal(docOnDisk().unsettledStarts, 0);
  assert.notEqual(ui(engine).status, "paused");
  quit.setQuitting(false);
  await retire(engine);
});

test("a count write still in flight when the quit stops the count never arms the timer", async () => {
  const { disk } = await syncedProfile();
  const held = defer();
  await ordinaryStart(disk, {
    before: () => {
      documents.saveDocument = async (name, value) => {
        if (name === "sync.json" && JSON.parse(value).unsettledStarts === 1) await held.promise;
        return stockSave(name, value);
      };
    },
  });
  try {
    quit.setQuitting(true);
    const quitting = quit.finishQuitSaves(5_000);
    await settle();
    held.resolve();
    await quitting;
    await settle();
    assert.deepEqual(settleTimers(), []);
  } finally {
    restoreDocuments();
  }
});

test("a hanging unlock doesn't arm the two-minute timer; the load does", async () => {
  const { disk } = await syncedProfile();
  const held = defer();
  const engine = await ordinaryStart(disk, { before: () => void (syncNative.unlock = () => held.promise) });
  assert.equal(docOnDisk().unsettledStarts, 1);
  assert.deepEqual(settleTimers(), [], "nothing risky ran yet");
  held.resolve(true);
  await settle();
  assert.ok(calls.openLocal > 0);
  assert.equal(settleTimers().length, 1);
  assert.equal(docOnDisk().unsettledStarts, 1);
  await retire(engine);
});

test("a locked start stays counted until its phrase leads to a load", async () => {
  const { disk } = await syncedProfile();
  const engine = await ordinaryStart(disk, { keyMissing: true });
  assert.equal(ui(engine).status, "locked");
  assert.equal(docOnDisk().unsettledStarts, 1);
  assert.deepEqual(settleTimers(), []);
  assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "the words")));
  await settle();
  assert.equal(settleTimers().length, 1);
  await retire(engine);
});

test("a Resume longer than two minutes arms the timer again when it ends updated", async () => {
  const { disk } = await syncedProfile();
  disk.set("sync.json", JSON.stringify({ ...JSON.parse(disk.get("sync.json")), unsettledStarts: 2 }));
  const engine = await ordinaryStart(disk);
  assert.equal(ui(engine).status, "paused");
  const held = defer();
  syncNative.chainStatus = () => held.promise;
  const resume = engine.resumeSync();
  await settle();
  for (const { fn } of settleTimers()) fn();
  stub.timers = stub.timers.filter(({ ms }) => ms !== 120_000);
  await settle();
  assert.equal(docOnDisk().unsettledStarts, 3, "the count doesn't move while the pause is set");
  held.resolve("ok");
  await resume;
  assert.equal(ui(engine).status, "updated");
  assert.equal(settleTimers().length, 1);
  for (const { fn } of settleTimers()) fn();
  await settle();
  assert.equal(docOnDisk().unsettledStarts, 0);
  await retire(engine);
});

test("a failed re-read after a failed Resume never lowers a sequence, and the retry uploads nothing twice", async () => {
  const { disk, seqs } = await syncedProfile();
  const engine = await pausedStart(disk);
  let fail = true;
  let unreadableOnce = false;
  syncNative.read = async (...args) => {
    if (fail && args[1] !== "app") {
      unreadableOnce = true;
      throw new Error("later scope unavailable");
    }
    return stockNativeRead(...args);
  };
  documents.readDocument = (name) => {
    if (unreadableOnce && name === "sync.json") {
      unreadableOnce = false;
      return null;
    }
    return stockRead(name);
  };
  const lowest = [];
  const set = shell.docs.set;
  shell.docs.set = function (name, contents) {
    if (name === "sync.json") lowest.push(JSON.parse(contents).seqs?.app ?? 0);
    return set.call(this, name, contents);
  };
  try {
    S().updateSettings({ warnBeforeQuitting: false });
    await engine.resumeSync();
    await settle();
    assert.equal(ui(engine).status, "paused");
    const written = docOnDisk().seqs.app;
    assert.equal(written, seqs.app + 1);
    fail = false;
    await engine.resumeSync();
    await settle();
    assert.equal(ui(engine).status, "updated");
    assert.ok(lowest.slice(lowest.indexOf(written)).every((seq) => seq >= written), `no write lowers app below ${written}: ${lowest}`);
  } finally {
    shell.docs.set = set;
    restoreDocuments();
  }
  const published = new Set();
  for (const file of folder.values()) {
    const payload = JSON.parse(file.payload);
    if (payload.kind !== "log") continue;
    const key = `${file.scope} ${payload.device} ${payload.seq}`;
    assert.ok(!published.has(key), `${key} uploaded twice`);
    published.add(key);
  }
  await retire(engine);
});

test("a phrase accepted while Stop is under way does nothing more", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk, { keyMissing: true });
  await engine.resumeSync();
  assert.equal(ui(engine).status, "locked");
  const phraseReply = defer();
  const forgetReply = defer();
  let installed = false;
  let forgetStarted = false;
  syncNative.enterPhrase = async () => {
    await phraseReply.promise;
    installed = true;
    return { ok: true };
  };
  syncNative.forget = async () => {
    forgetStarted = true;
    await forgetReply.promise;
    installed = false;
  };
  syncNative.unlock = async () => installed;
  const phrase = engine.enterRecoveryPhrase("/sync", "example");
  const stop = engine.stopSync();
  await settle();
  assert.ok(forgetStarted);
  phraseReply.resolve();
  await phrase;
  await settle();
  assert.equal(calls.chainStatus, 0, "no cycle starts");
  assert.notEqual(ui(engine).status, "updated");
  forgetReply.resolve();
  await stop;
  await settle();
  assert.equal(ui(engine).status, "off");
});
