import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, docOnDisk, engineInstance, pausedStart, quit, reads, retire, S, sealedFiles, setConsentPeriod, settle, shell, stub, syncedProfile, syncFileNames, takeSyncPauseCounts, timersRun, writes } from "./fixtures/pausedSync.mjs";

const { syncFiles } = await import("./syncFiles.ts");

test("a recovered start with sync on loads nothing, schedules no cycle, and records the pause beside the seqs it read", async () => {
  const { disk, seqs } = await syncedProfile();
  const sealedBefore = Object.fromEntries([...disk].filter(([name]) => name.startsWith("sync-")));
  const engine = await pausedStart(disk);

  assert.equal(engine.useSync.getState().status, "paused");
  assert.equal(engine.useSync.getState().enabled, true);
  assert.equal(calls.unlock, 0, "the sync key isn't unlocked");
  assert.equal(calls.openLocal, 0, "nothing sealed is opened");
  assert.deepEqual(reads.filter((name) => name.startsWith("sync")), ["sync.json"], "only sync.json is read");
  assert.deepEqual(writes.filter((name) => name.startsWith("sync")), ["sync.json"], "only sync.json is written");
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.deepEqual(docOnDisk().seqs, seqs, "the seqs read from disk are kept");
  assert.deepEqual(sealedFiles(), sealedBefore, "the state and journal parts are untouched");
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });

  S().addBookmark({ profileId: "default", url: "https://three.example/", title: "Three" });
  await engine.syncNow();
  assert.deepEqual(engine.sendTargets("default"), []);
  await timersRun();
  assert.equal(calls.chainStatus, 0, "no cycle runs, from a timer, an edit or Sync Now");
  assert.equal(calls.unlock, 0);
  assert.deepEqual(sealedFiles(), sealedBefore);
  assert.deepEqual(docOnDisk().seqs, seqs);
});

test("a later start that isn't recovered stays paused while the pause is on disk", async () => {
  const { disk, seqs } = await syncedProfile();
  await pausedStart(disk);
  const later = await pausedStart(new Map(shell.docs), { recoveredStart: false });
  assert.equal(later.useSync.getState().status, "paused");
  assert.equal(calls.unlock, 0);
  assert.equal(calls.openLocal, 0);
  await timersRun();
  assert.equal(calls.chainStatus, 0);
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.deepEqual(docOnDisk().seqs, seqs);
  assert.deepEqual(takeSyncPauseCounts().sync_paused_by_launch_guard, 0, "a start the guard didn't recover isn't counted as paused by it");
});

test("quitting while paused writes neither the state nor a journal part, and keeps the seqs", async () => {
  const { disk, seqs } = await syncedProfile();
  await pausedStart(disk);
  const before = sealedFiles();
  const docBefore = shell.docs.get("sync.json");
  writes.length = 0;
  quit.setQuitting(true);
  try {
    await quit.finishQuitSaves(5_000);
    await settle();
  } finally {
    quit.setQuitting(false);
  }
  assert.deepEqual(writes, [], "nothing is written at quit");
  assert.deepEqual(sealedFiles(), before);
  assert.equal(shell.docs.get("sync.json"), docBefore);
  assert.deepEqual(docOnDisk().seqs, seqs);
});

test("Resume unlocks, loads, runs one cycle, and clears the pause only after that cycle", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  let pausedDuringCycle = null;
  stub.duringRead = () => (pausedDuringCycle ??= docOnDisk().pausedByGuard === true);

  await engine.resumeSync();

  assert.equal(calls.unlock, 1);
  assert.ok(calls.openLocal > 0, "the saved state is loaded");
  assert.equal(calls.chainStatus, 1, "one cycle");
  assert.equal(pausedDuringCycle, true, "the pause is still on disk while the cycle runs");
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(docOnDisk().pausedByGuard, undefined, "and cleared once it finished");
  assert.ok(stub.timers.some(({ ms }) => ms === 15_000), "sync carries on as usual");
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_paused_after_unsettled_starts: 0, sync_resumes: 1, sync_resumes_completed: 1, sync_loads_refused_damaged: 0 });
  await retire(engine);
});

test("a Resume whose cycle fails stays paused, says why, and runs nothing more", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  stub.chainFails = true;
  await engine.resumeSync();
  assert.equal(engine.useSync.getState().status, "paused");
  assert.equal(engine.useSync.getState().error, "The sync folder went away");
  assert.equal(docOnDisk().pausedByGuard, true);
  const cycles = calls.chainStatus;
  stub.chainFails = false;
  await timersRun();
  assert.equal(calls.chainStatus, cycles, "no cycle follows on its own");
  quit.setQuitting(true);
  const before = sealedFiles();
  try {
    await quit.finishQuitSaves(5_000);
    await settle();
  } finally {
    quit.setQuitting(false);
  }
  assert.deepEqual(sealedFiles(), before, "and quitting writes no state");
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_paused_after_unsettled_starts: 0, sync_resumes: 1, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });
});

const lockedMessage = "Enter your recovery phrase to keep syncing on this Mac.";

async function resumedWithoutKey() {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk, { keyMissing: true });
  assert.equal(engine.useSync.getState().status, "paused", "a start with the pause on disk and no key shows paused");
  const sealedBefore = sealedFiles();
  const docBefore = shell.docs.get("sync.json");
  writes.length = 0;
  await engine.resumeSync();
  return { engine, sealedBefore, docBefore };
}

test("a Resume whose unlock fails asks for the recovery phrase, keeps the pause, and writes nothing", async () => {
  const { engine, sealedBefore, docBefore } = await resumedWithoutKey();
  assert.equal(engine.useSync.getState().status, "locked");
  assert.equal(engine.useSync.getState().error, lockedMessage);
  assert.equal(calls.unlock, 1);
  assert.equal(calls.openLocal, 0);
  assert.equal(calls.chainStatus, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(sealedFiles(), sealedBefore);
  assert.equal(shell.docs.get("sync.json"), docBefore);
  assert.equal(docOnDisk().pausedByGuard, true);
  await timersRun();
  assert.equal(calls.chainStatus, 0, "locked and paused, no cycle runs");
});

test("entering the phrase after that finishes the resume and clears the pause after its cycle", async () => {
  const { engine } = await resumedWithoutKey();
  let pausedDuringCycle = null;
  stub.duringRead = () => (pausedDuringCycle ??= docOnDisk().pausedByGuard === true);
  assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "the words")));
  await settle();
  assert.equal(calls.enterPhrase, 1);
  assert.equal(calls.unlock, 2);
  assert.ok(calls.openLocal > 0);
  assert.equal(calls.chainStatus, 1, "one cycle");
  assert.equal(pausedDuringCycle, true);
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(docOnDisk().pausedByGuard, undefined);
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_paused_after_unsettled_starts: 0, sync_resumes: 1, sync_resumes_completed: 1, sync_loads_refused_damaged: 0 }, "the phrase continues the press, it isn't a second one");
  await retire(engine);
});

test("entering the phrase when the resumed cycle fails leaves it paused", async () => {
  const { engine } = await resumedWithoutKey();
  stub.chainFails = true;
  assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "the words")));
  await settle();
  assert.equal(engine.useSync.getState().status, "paused");
  assert.equal(engine.useSync.getState().error, "The sync folder went away");
  assert.equal(docOnDisk().pausedByGuard, true);
});

test("without a pause, the phrase on a locked start goes down the ordinary path", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk, { recoveredStart: false, keyMissing: true });
  assert.equal(engine.useSync.getState().status, "locked");
  assert.equal(engine.useSync.getState().error, lockedMessage);
  assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "the words")));
  await settle();
  assert.equal(calls.unlock, 1, "the launch unlock only");
  assert.ok(calls.openLocal > 0, "the saved state is loaded");
  assert.equal(engine.useSync.getState().status, "starting");
  assert.ok(stub.timers.some(({ ms }) => ms === 0), "and a cycle is scheduled at once");
  assert.equal(calls.chainStatus, 0);
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });
  await retire(engine);
});

test("a crash during Resume leaves the next start paused", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  stub.hold.read = true;
  void engine.resumeSync();
  await settle();
  assert.equal(calls.read > 0, true, "the cycle is under way");
  assert.equal(docOnDisk().pausedByGuard, true);
  const afterCrash = await pausedStart(new Map(shell.docs), { recoveredStart: false });
  assert.equal(afterCrash.useSync.getState().status, "paused");
  assert.equal(calls.unlock, 0);
  assert.equal(calls.openLocal, 0);
});

test("with sync off a recovered start changes nothing", async () => {
  S().hydrate({});
  shell.docs.clear();
  const engine = await pausedStart(new Map());
  assert.equal(engine.useSync.getState().status, "off");
  assert.equal(shell.docs.get("sync.json"), undefined);
  assert.deepEqual(writes.filter((name) => name.startsWith("sync")), []);
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });
  await engine.resumeSync();
  assert.equal(calls.unlock, 0);
});

test("with sharing off nothing is counted", async () => {
  const { disk } = await syncedProfile();
  setConsentPeriod(false, null);
  try {
    const engine = await pausedStart(disk);
    await engine.resumeSync();
    assert.equal(engine.useSync.getState().status, "updated");
    assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });
    await retire(engine);
  } finally {
    setConsentPeriod(true, "sync-pause-test");
  }
});

test("sync.json saved before the scopes are loaded keeps the seqs it was read with", async () => {
  shell.docs.clear();
  Map.prototype.set.call(shell.docs, "sync.json", JSON.stringify({ enabled: true, folder: "/sync", deviceId: "devA", seqs: { app: 4, "p:x": 7 }, v: 1 }));
  let doc = null;
  const files = syncFiles(() => doc);
  doc = files.read();
  doc.pausedByGuard = true;
  files.save();
  await files.checkpoint();
  await settle();
  assert.deepEqual(docOnDisk().seqs, { app: 4, "p:x": 7 });
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.equal(shell.docs.get("sync-state.nns"), undefined);
});
