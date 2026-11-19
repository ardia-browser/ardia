import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, docOnDisk, pausedStart, quit, restore, sealedFiles, setConsentPeriod, settle, shell, syncedProfile, takeSyncPauseCounts } from "./fixtures/pausedSync.mjs";

const { syncFiles, SyncStateDamaged } = await import("./syncFiles.ts");
const { SYNC_DAMAGED } = await import("./syncPause.ts");
const { syncControls } = await import("./syncControls.ts");

const ui = (engine) => engine.useSync.getState();
const ordinaryStart = (disk, options = {}) => pausedStart(disk, { recoveredStart: false, ...options });
const opened = (disk, name) => JSON.parse(disk.get(name).slice("sealed:".length));
const seal = (value) => `sealed:${JSON.stringify(value)}`;
const partNames = (disk) => [...disk.keys()].filter((name) => /^sync-journal-\d+\.nns$/.test(name));

function damageCheckpoint(disk, mutate) {
  const state = opened(disk, "sync-state.nns");
  mutate(state.scopes);
  disk.set("sync-state.nns", seal(state));
}

function damagePart(disk, has, mutate) {
  const covers = opened(disk, "sync-state.nns").covers;
  for (const name of partNames(disk)) {
    const part = opened(disk, name);
    if (part.id <= covers || !has(part)) continue;
    mutate(part);
    disk.set(name, seal(part));
    return;
  }
  assert.fail("no journal part to damage");
}

const firstRecord = (scopes) => {
  for (const scope of Object.values(scopes)) for (const key of Object.keys(scope.records)) return { scope, key };
  assert.fail("no record");
};
const withChanges = (part) => part.changes && Object.values(part.changes).some((change) => Object.keys(change.records).length);
const firstChange = (part) => Object.values(part.changes).find((change) => Object.keys(change.records).length);
const withBatch = (part) => part.journal && Object.values(part.journal).some((files) => files.some((file) => file.ops.length));

const DAMAGE = {
  "a record without its stamp, as in the field": (disk) => damageCheckpoint(disk, (scopes) => { const { scope, key } = firstRecord(scopes); delete scope.records[key].h; }),
  "a record that isn't an object": (disk) => damageCheckpoint(disk, (scopes) => { const { scope, key } = firstRecord(scopes); scope.records[key] = "broken"; }),
  "a record with a wrong origin": (disk) => damageCheckpoint(disk, (scopes) => { const { scope, key } = firstRecord(scopes); scope.records[key].o = ["devP"]; }),
  "a base entry that isn't text": (disk) => damageCheckpoint(disk, (scopes) => { const scope = Object.values(scopes).find((s) => Object.keys(s.base).length); scope.base[Object.keys(scope.base)[0]] = 5; }),
  "a journal part whose changes hold a bad record": (disk) => damagePart(disk, withChanges, (part) => { const change = firstChange(part); change.records[Object.keys(change.records)[0]] = { v: { t: "x" } }; }),
  "a batch with an op without its stamp": (disk) => damagePart(disk, withBatch, (part) => { const files = Object.values(part.journal).find((list) => list.some((file) => file.ops.length)); delete files.find((file) => file.ops.length).ops[0].h; }),
};

async function damagedProfile(kind) {
  const { disk } = await syncedProfile();
  DAMAGE[kind](disk);
  return disk;
}

for (const kind of Object.keys(DAMAGE)) {
  test(`${kind}: the load rejects as damaged and changes nothing`, async () => {
    const disk = await damagedProfile(kind);
    restore(disk);
    const doc = JSON.parse(disk.get("sync.json"));
    const before = { scopes: (doc.scopes = {}), clock: doc.clock, seqs: doc.seqs };
    const files = syncFiles(() => doc);
    const counts = files.journalCounts();
    const sealed = sealedFiles();
    const seqsOnDisk = docOnDisk().seqs;
    await assert.rejects(files.loadState(), (error) => error instanceof SyncStateDamaged && !(error instanceof TypeError));
    assert.equal(doc.scopes, before.scopes);
    assert.deepEqual(doc.scopes, {});
    assert.equal(doc.clock, before.clock);
    assert.deepEqual(files.journalCounts(), counts, "the journal bookkeeping is untouched");
    assert.equal(files.loaded(), false);
    assert.deepEqual(files.writtenSeqs(), before.seqs);
    files.save();
    await files.checkpoint();
    await settle();
    assert.deepEqual(sealedFiles(), sealed, "nothing is written to the state or the journal");
    assert.deepEqual(docOnDisk().seqs, seqsOnDisk, "and sync.json keeps its seqs");
  });
}

test("a null in a part's changes is the deletion mark and still loads, and an old checkpoint without the newer fields loads", async () => {
  const { disk } = await syncedProfile();
  let deleted = null;
  damagePart(disk, withChanges, (part) => {
    const [scope, change] = Object.entries(part.changes).find(([, c]) => Object.keys(c.records).length);
    const key = Object.keys(change.records)[0];
    deleted = { scope, key };
    change.records[key] = null;
    change.base = { ...change.base, [key]: null };
  });
  const state = opened(disk, "sync-state.nns");
  for (const scope of Object.values(state.scopes)) for (const field of Object.keys(scope)) if (field !== "records" && field !== "base") delete scope[field];
  disk.set("sync-state.nns", seal(state));
  restore(disk);
  const doc = { ...JSON.parse(disk.get("sync.json")), scopes: {} };
  const files = syncFiles(() => doc);
  await files.loadState();
  assert.equal(files.loaded(), true);
  assert.ok(Object.keys(doc.scopes).length > 0);
  assert.equal(deleted.key in doc.scopes[deleted.scope].records, false, "the deletion was replayed");
  assert.equal(deleted.key in doc.scopes[deleted.scope].base, false);
});

test("a damaged state at the start ends stalled in plain words, runs no cycle, and leaves the files as they were through a quit", async () => {
  const disk = await damagedProfile("a record without its stamp, as in the field");
  const sealed = Object.fromEntries([...disk].filter(([name]) => name.startsWith("sync-")));
  const engine = await ordinaryStart(disk);
  assert.equal(ui(engine).status, "stalled");
  assert.equal(ui(engine).error, SYNC_DAMAGED);
  assert.equal(calls.chainStatus, 0);
  assert.deepEqual(sealedFiles(), sealed);
  const seqsOnDisk = docOnDisk().seqs;
  quit.setQuitting(true);
  await quit.finishQuitSaves(5_000);
  assert.deepEqual(sealedFiles(), sealed, "the quit writes no state and no journal part");
  assert.deepEqual(docOnDisk().seqs, seqsOnDisk);
});

test("Sync Now meets the same damage the same way, counts it once and runs no cycle", async () => {
  const disk = await damagedProfile("a record that isn't an object");
  const engine = await ordinaryStart(disk);
  const opensAtStart = calls.openLocal;
  await engine.syncNow();
  assert.ok(calls.openLocal > opensAtStart, "Sync Now tried the load again");
  await engine.syncNow();
  assert.equal(ui(engine).status, "stalled");
  assert.equal(ui(engine).error, SYNC_DAMAGED);
  assert.equal(calls.chainStatus, 0);
  assert.equal(takeSyncPauseCounts().sync_loads_refused_damaged, 1, "once a session");
});

test("a recovery phrase that leads to a damaged load ends in the same words", async () => {
  const disk = await damagedProfile("a base entry that isn't text");
  const engine = await ordinaryStart(disk, { keyMissing: true });
  assert.equal(ui(engine).status, "locked");
  assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "the words")));
  await settle();
  assert.equal(ui(engine).status, "stalled");
  assert.equal(ui(engine).error, SYNC_DAMAGED);
  assert.equal(calls.chainStatus, 0);
});

test("a Resume that meets a damaged state stays paused in the same words", async () => {
  const disk = await damagedProfile("a batch with an op without its stamp");
  const engine = await pausedStart(disk);
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "paused");
  assert.equal(ui(engine).error, SYNC_DAMAGED);
  assert.equal(calls.chainStatus, 0);
  assert.equal(docOnDisk().pausedByGuard, true);
});

test("with sharing off a damaged load isn't counted", async () => {
  const disk = await damagedProfile("a record with a wrong origin");
  setConsentPeriod(false, null);
  try {
    const engine = await ordinaryStart(disk);
    await engine.syncNow();
    assert.equal(ui(engine).error, SYNC_DAMAGED);
    assert.equal(takeSyncPauseCounts().sync_loads_refused_damaged, 0);
  } finally {
    setConsentPeriod(true, "sync-pause-test");
  }
});

test("Stop Syncing is offered from a damaged state, stalled or paused, and leaves Sync off", async () => {
  assert.ok(syncControls({ status: "stalled", paused: false }).advanced.includes("stop"));
  assert.ok(syncControls({ status: "paused", paused: true }).advanced.includes("stop"));
  const { disk } = await syncedProfile();
  const covers = opened(disk, "sync-state.nns").covers;
  disk.set("sync-journal.nns", seal({ id: covers + 1, journal: { app: [{ v: 1, kind: "log", device: "devP", seq: 99, at: 1, ops: [{ k: "bm:old", v: null }] }] }, version: 1 }));
  const engine = await ordinaryStart(disk);
  assert.equal(ui(engine).error, SYNC_DAMAGED, "the old single journal holds a batch without a stamp");
  await engine.stopSync();
  await settle();
  assert.equal(ui(engine).status, "off");
  assert.equal(docOnDisk().enabled, false);
  assert.ok(!shell.docs.get("sync-journal.nns"), "the old single journal is emptied too, so a rejoin doesn't meet it again");
  assert.equal(calls.chainStatus, 0, "no cycle on the damaged state, not even a last one");
});
