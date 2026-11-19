import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, docOnDisk, pausedStart, quit, reads, retire, setConsentPeriod, settle, shell, stub, syncedProfile, syncNative, takeSyncPauseCounts, writes } from "./fixtures/pausedSync.mjs";

const documents = shell.shellNativeModules.ArdiaDocuments;
const stockSave = documents.saveDocument;
const ui = (engine) => engine.useSync.getState();
const ordinaryStart = (disk, before) => pausedStart(disk, { recoveredStart: false, before });
const snapshot = () => new Map(shell.docs);
const NO_COUNTS = { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 };

async function runSettleTimer() {
  const due = stub.timers.filter(({ ms }) => ms === 120_000);
  stub.timers = stub.timers.filter(({ ms }) => ms !== 120_000);
  for (const { fn } of due) fn();
  await settle();
  return due.length;
}

test("two starts that end without a quit or two minutes pause the third, which unlocks and reads nothing", async () => {
  const { disk, seqs } = await syncedProfile();
  await ordinaryStart(disk);
  assert.equal(docOnDisk().unsettledStarts, 1);
  assert.equal(calls.unlock, 1, "the first start loads");
  await ordinaryStart(snapshot());
  assert.equal(docOnDisk().unsettledStarts, 2);
  assert.equal(calls.unlock, 1, "so does the second");
  const third = await ordinaryStart(snapshot());
  assert.equal(ui(third).status, "paused");
  assert.equal(calls.unlock, 0);
  assert.equal(calls.openLocal, 0);
  assert.deepEqual(reads.filter((name) => name.startsWith("sync")), ["sync.json"]);
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.equal(docOnDisk().unsettledStarts, 2, "the count doesn't move once paused");
  assert.deepEqual(docOnDisk().seqs, seqs);
  assert.deepEqual(takeSyncPauseCounts(), { ...NO_COUNTS, sync_paused_after_unsettled_starts: 1 });
});

test("the count write lands before the unlock and keeps the seqs on disk", async () => {
  const { disk, seqs } = await syncedProfile();
  let atUnlock = null;
  await ordinaryStart(disk, () => {
    syncNative.unlock = () => {
      atUnlock = docOnDisk();
      return new Promise(() => {});
    };
  });
  assert.equal(atUnlock?.unsettledStarts, 1, "the count is on disk when the unlock starts");
  assert.deepEqual(atUnlock?.seqs, seqs);
  assert.equal(calls.openLocal, 0, "nothing is loaded yet");
});

test("a clean quit after the first start resets the count, so the third start loads", async () => {
  const { disk } = await syncedProfile();
  await ordinaryStart(disk);
  await settle();
  await quit.finishQuitSaves(5_000);
  assert.equal(docOnDisk().unsettledStarts, 0);
  await ordinaryStart(snapshot());
  const third = await ordinaryStart(snapshot());
  assert.notEqual(ui(third).status, "paused");
  assert.equal(calls.unlock, 1);
});

test("a quit seconds after the start, before the load has finished, still resets the count", async () => {
  const { disk } = await syncedProfile();
  await ordinaryStart(disk, () => void (stub.hold.unlock = true));
  assert.equal(docOnDisk().unsettledStarts, 1);
  await quit.finishQuitSaves(5_000);
  assert.equal(docOnDisk().unsettledStarts, 0);
});

test("two minutes alive after Sync began loading resets the count, keeping the seqs", async () => {
  const { disk, seqs } = await syncedProfile();
  await ordinaryStart(disk);
  assert.equal(docOnDisk().unsettledStarts, 1);
  assert.equal(await runSettleTimer(), 1, "one timer");
  assert.equal(docOnDisk().unsettledStarts, 0);
  assert.deepEqual(docOnDisk().seqs, seqs);
});

test("a refused count write warns and still loads", async () => {
  const { disk } = await syncedProfile();
  documents.saveDocument = (name, contents) => (name === "sync.json" && JSON.parse(contents).unsettledStarts === 1 ? Promise.reject(new Error("disk full")) : stockSave(name, contents));
  try {
    const engine = await ordinaryStart(disk);
    assert.equal(calls.unlock, 1);
    assert.ok(calls.openLocal > 0);
    assert.notEqual(ui(engine).status, "paused");
  } finally {
    documents.saveDocument = stockSave;
  }
});

test("the count never moves while paused, through timers, a quit and a later start", async () => {
  const { disk } = await syncedProfile();
  const seeded = new Map(disk);
  seeded.set("sync.json", JSON.stringify({ ...JSON.parse(disk.get("sync.json")), unsettledStarts: 1 }));
  await pausedStart(seeded);
  assert.equal(docOnDisk().unsettledStarts, 1);
  assert.equal(await runSettleTimer(), 0, "no settle timer while paused");
  await quit.finishQuitSaves(5_000);
  assert.equal(docOnDisk().unsettledStarts, 1);
  const later = await ordinaryStart(snapshot());
  assert.equal(ui(later).status, "paused");
  assert.equal(docOnDisk().unsettledStarts, 1);
});

test("Resume counts as a load: a death during it stays paused, and a finished one leaves the count to the timer", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  stub.hold.read = true;
  void engine.resumeSync();
  await settle();
  assert.equal(docOnDisk().unsettledStarts, 1, "the Resume's load is counted before it runs");
  const afterDeath = await ordinaryStart(snapshot());
  assert.equal(ui(afterDeath).status, "paused");
  await afterDeath.resumeSync();
  await settle();
  assert.equal(ui(afterDeath).status, "updated");
  assert.equal(docOnDisk().pausedByGuard, undefined);
  assert.equal(docOnDisk().unsettledStarts, 2);
  assert.equal(await runSettleTimer(), 1);
  assert.equal(docOnDisk().unsettledStarts, 0);
  await retire(afterDeath);
});

test("with sync off no count is kept", async () => {
  shell.docs.clear();
  const engine = await ordinaryStart(new Map());
  assert.equal(ui(engine).status, "off");
  assert.equal(shell.docs.get("sync.json"), undefined);
  assert.deepEqual(writes.filter((name) => name.startsWith("sync")), []);
  assert.equal(await runSettleTimer(), 0);
});

test("with sharing off a pause after unsettled starts isn't counted", async () => {
  const { disk } = await syncedProfile();
  const seeded = new Map(disk);
  seeded.set("sync.json", JSON.stringify({ ...JSON.parse(disk.get("sync.json")), unsettledStarts: 2 }));
  setConsentPeriod(false, null);
  try {
    const engine = await ordinaryStart(seeded);
    assert.equal(ui(engine).status, "paused");
    assert.deepEqual(takeSyncPauseCounts(), NO_COUNTS);
  } finally {
    setConsentPeriod(true, "sync-pause-test");
  }
});

test("an engine started without counting, as Linux's authority is at every handover, keeps no count and never pauses", async () => {
  const { disk } = await syncedProfile();
  const { unsettledStarts: _left, ...linuxDoc } = JSON.parse(disk.get("sync.json"));
  disk.set("sync.json", JSON.stringify(linuxDoc));
  const linux = { recoveredStart: false, startOptions: { countStarts: false } };
  const first = await pausedStart(disk, linux);
  assert.notEqual(ui(first).status, "paused");
  assert.equal("unsettledStarts" in docOnDisk(), false);
  const second = await pausedStart(snapshot(), linux);
  const third = await pausedStart(snapshot(), linux);
  assert.notEqual(ui(second).status, "paused");
  assert.notEqual(ui(third).status, "paused");
  assert.equal("unsettledStarts" in docOnDisk(), false);
  assert.equal(await runSettleTimer(), 0);
  assert.deepEqual(takeSyncPauseCounts(), NO_COUNTS);
});
