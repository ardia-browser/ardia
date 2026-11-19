import assert from "node:assert/strict";
import { test } from "node:test";
import { pausedStart, restore, settle, syncNative } from "./fixtures/pausedSync.mjs";

const { syncFiles, SyncStateDamaged } = await import("./syncFiles.ts");
const { emptyDoc } = await import("./syncDoc.ts");
const { SYNC_DAMAGED } = await import("./syncPause.ts");

const h = "000000001.0000.devP";
const record = { h, v: null, o: ["devP", 1] };
const log = (device, ops = [{ k: "bm:x", h, v: null }]) => ({ v: 1, kind: "log", device, seq: 1, at: 1, ops });
const seal = (value) => `sealed:${JSON.stringify(value)}`;
const seed = (extra = {}) => ({ ...emptyDoc(), enabled: true, deviceId: "devP", folder: "/sync", seqs: {}, ...extra });
const checkpoint = (app = {}, extra = {}) => ({ version: 1, covers: 0, scopes: { app: { records: {}, base: {}, ...app } }, ...extra });
const ui = (engine) => engine.useSync.getState();

function diskOf(state, parts = [], { legacy, doc = seed() } = {}) {
  const disk = new Map([["sync.json", JSON.stringify(doc)]]);
  if (state) disk.set("sync-state.nns", seal(state));
  for (const [i, part] of parts.entries()) disk.set(`sync-journal-${i + 1}.nns`, seal({ version: 1, ...part }));
  if (legacy) disk.set("sync-journal.nns", seal({ version: 1, ...legacy }));
  return disk;
}

async function load(state, parts, options = {}) {
  const doc = options.doc ?? seed();
  restore(diskOf(state, parts, { ...options, doc }));
  const files = syncFiles(() => doc);
  await files.loadState();
  return { doc, files };
}

const refuses = (state, parts, options) => assert.rejects(load(state, parts, options), SyncStateDamaged);

test("an unlinked checkpoint scope is judged only on what the load and the summary read", async () => {
  const { doc } = await load({ ...checkpoint(), scopes: { app: { records: {}, base: {} }, "p:gone": { records: { "bm:x": record }, base: { x: 42 }, vv: "kept as it was" } } });
  assert.deepEqual(doc.scopes["p:gone"].base, { x: 42 });
  await refuses({ ...checkpoint(), scopes: { app: { records: {}, base: {} }, "p:gone": { records: { "bm:x": { ...record, h: "zzzzzzzzz.!.devP" } }, base: {} } } });
  await refuses({ ...checkpoint(), scopes: { app: { records: {}, base: {} }, "p:gone": { records: {}, base: {}, seen: null } } });
});

test("another device's part is read, and its batches and changes are left to the owner filter unjudged", async () => {
  const foreign = { id: 1, device: "devQ", journal: { app: [log("devQ", null)] }, changes: { app: "not this device's" } };
  const { doc, files } = await load(checkpoint(), [foreign]);
  assert.equal(files.journalCounts().parts, 1, "the part was opened");
  assert.equal(files.loaded(), true);
  assert.equal(doc.scopes.app.seq, 0);
  await refuses(checkpoint(), [{ id: 1, journal: { app: [log("devP", null)] } }]);
});

test("after a rejoin, an old device's leftover batch in the old single journal doesn't refuse the new device's load", async () => {
  const leftover = { journal: { app: [log("devOld", [{ k: "bm:x", v: null }])] } };
  const engine = await pausedStart(diskOf(null, [], { legacy: leftover, doc: seed({ deviceId: "devNew" }) }), { recoveredStart: false });
  assert.notEqual(ui(engine).status, "stalled");
  assert.equal(ui(engine).error, null);
});

for (const [name, state, parts] of [
  ["a part whose batches aren't a map", checkpoint(), [{ id: 1, journal: [log("devP")] }]],
  ["a part whose changes aren't a map", checkpoint(), [{ id: 1, device: "devP", changes: [{ records: {}, base: {}, rest: {} }] }]],
  ["a checkpoint whose covers isn't a whole number", checkpoint({}, { covers: 2.5 }), [{ id: 1, journal: { app: [log("devP")] } }]],
  ["a checkpoint whose covers isn't a number", checkpoint({}, { covers: "1" }), []],
]) {
  test(`${name} is damage, not a silent skip`, () => refuses(state, parts));
}

for (const [field, value] of [
  ["seen", null],
  ["seen", { devQ: "yesterday" }],
  ["files", { known: null }],
  ["files", { known: { d: "devQ" } }],
  ["damaged", null],
  ["applyAs", true],
  ["applyAs", { "bm:x": 3 }],
  ["pendingSince", { "bm:x": "soon" }],
]) {
  test(`a linked scope whose ${field} is ${JSON.stringify(value)} is damage`, () => refuses(checkpoint({ [field]: value })));
}

test("seen: null at the start ends stalled in the words, with no unhandled rejection", async () => {
  const rejections = [];
  const collect = (error) => rejections.push(error);
  process.on("unhandledRejection", collect);
  try {
    const engine = await pausedStart(diskOf(checkpoint({ seen: null })), { recoveredStart: false });
    await settle();
    assert.equal(ui(engine).status, "stalled");
    assert.equal(ui(engine).error, SYNC_DAMAGED);
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", collect);
  }
});

test("a stamp the clock can't read is damage, in a record, an op and the saved clock; old wide stamps still load", async () => {
  await refuses(checkpoint({ records: { "bm:x": { ...record, h: "zzzzzzzzz.!.devP" } } }));
  await refuses(checkpoint({ records: { "bm:x": { ...record, h: "garbage" } } }));
  await refuses(checkpoint(), [{ id: 1, journal: { app: [log("devP", [{ k: "bm:x", h: "zzzzzzzzz.!.devP", v: null }])] } }]);
  await refuses(checkpoint({}, { clock: "zzzzzzzzz.!.devP" }));
  const { doc } = await load(checkpoint({ records: { "bm:x": { ...record, h: "0000000001000.0000.peer" } } }));
  assert.ok(doc.scopes.app.records["bm:x"]);
});

test("a sequence number in sync.json that isn't one is damage", () => refuses(checkpoint(), [], { doc: seed({ seqs: { app: "broken" } }) }));

test("the warning names the kind of damage, never a scope or a part", async () => {
  const syncId = "wvbm2zkqv77rgqbizqdxlzdoea";
  const doc = seed({ profiles: { default: { syncId, enabled: true } } });
  restore(diskOf({ ...checkpoint(), scopes: { app: { records: {}, base: {} }, [`p:${syncId}`]: { records: {}, base: { x: 42 } } } }, [], { doc }));
  await assert.rejects(syncFiles(() => doc).loadState(), (error) => error instanceof SyncStateDamaged && !error.message.includes(syncId) && !error.message.includes("p:"));
  const docP = seed();
  restore(diskOf(checkpoint(), [{ id: 777, journal: { app: [log("devP", null)] } }], { doc: docP }));
  await assert.rejects(syncFiles(() => docP).loadState(), (error) => error instanceof SyncStateDamaged && !error.message.includes("777") && !error.message.includes("app"));
});

test("a recovery phrase whose load fails for another reason rejects as before", async () => {
  const engine = await pausedStart(diskOf(checkpoint()), { recoveredStart: false, keyMissing: true });
  assert.equal(ui(engine).status, "locked");
  syncNative.openLocal = async () => {
    throw new Error("native open failed");
  };
  await assert.rejects(engine.enterRecoveryPhrase("/sync", "words"), /native open failed/);
});

test("Sync Now whose load fails for another reason adds no warning", async () => {
  const engine = await pausedStart(diskOf(checkpoint()), {
    recoveredStart: false,
    before: () => {
      const open = syncNative.openLocal;
      syncNative.openLocal = async (value) => {
        void open;
        throw new Error("native open failed");
      };
    },
  });
  assert.equal(ui(engine).status, "stalled");
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => void warned.push(String(args[0]));
  try {
    await engine.syncNow();
  } finally {
    console.warn = warn;
  }
  assert.equal(ui(engine).error, "native open failed");
  assert.deepEqual(warned.filter((line) => line.startsWith("[sync]")), []);
});
