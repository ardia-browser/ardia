import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
let sealHook = null;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    sealLocal: async (text) => (sealHook ? sealHook(text) : `sealed:${text}`),
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
  },
};

const shell = await import("../../test-native/index.ts");
const { syncFiles } = await import("./syncFiles.ts");
const { emptyDoc } = await import("./syncDoc.ts");
const { emptyScope, Clock, putBase, putRecord } = await import("@ardia/sync");

const realNow = Date.now;
const HOUR = 60 * 60_000;
const record = { h: "000000001.0000.devA", v: { t: "Kept" }, o: ["devA", 1] };
const scope = { ...emptyScope(), records: { "bm:x": record }, base: { "bm:x": '{"t":"Kept"}' }, seq: 1, vv: { devA: 1 } };
const sealed = (value) => `sealed:${JSON.stringify(value)}`;
const opened = (name) => JSON.parse(shell.docs.get(name).slice(7));
const parts = () => [...shell.docs.keys()].filter((n) => /^sync-journal-\d+\.nns$/.test(n)).sort((a, b) => partNumber(a) - partNumber(b));
const partNumber = (name) => Number(/(\d+)\.nns$/.exec(name)[1]);
const batch = (seq, ops = [{ k: `bm:${seq}`, h: `00000000${seq}.0000.devA`, v: { t: `B${seq}` } }]) => ({ v: 1, kind: "log", device: "devA", seq, at: 0, ops });
const tick = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

function newDoc(extra = {}) {
  return { ...emptyDoc(), enabled: true, deviceId: "devA", folder: "/sync", seqs: {}, ...extra };
}

async function opening({ docs = {}, doc = newDoc() } = {}) {
  shell.docs.clear();
  for (const [name, contents] of Object.entries(docs)) shell.docs.set(name, contents);
  const files = syncFiles(() => doc);
  await files.loadState();
  return { doc, files };
}

async function restart(doc) {
  const next = newDoc({ profiles: doc.profiles, seqs: Object.fromEntries(Object.entries(doc.scopes).map(([k, s]) => [k, s.seq - (s.journal?.length ?? 0)])), clock: doc.clock });
  const files = syncFiles(() => next);
  await files.loadState();
  return { doc: next, files };
}

function startOver(files) {
  if (files.startOver) return files.startOver();
  files.clearJournal();
  files.save({ stateNow: true });
}

const afterAnHour = async (fn) => {
  Date.now = () => realNow() + HOUR + 1;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
};

async function sealHeld(match) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let waiting = false;
  sealHook = async (text) => {
    if (match(text)) {
      waiting = true;
      await held;
    }
    return `sealed:${text}`;
  };
  return { release: () => (sealHook = null, release()), waiting: () => waiting };
}

test("a sealed state saved as bare scopes, before checkpoints, still loads", async () => {
  const { doc } = await opening({ docs: { "sync-state.nns": sealed({ app: scope }) }, doc: newDoc({ seqs: { app: 1 } }) });
  assert.deepEqual(doc.scopes.app.records, { "bm:x": record });
  assert.equal(doc.scopes.app.seq, 1);
});

test("a checkpoint saved before it carried a version still loads", async () => {
  const { doc } = await opening({ docs: { "sync-state.nns": sealed({ covers: 5, clock: "000000002.0000.devA", scopes: { app: scope } }) }, doc: newDoc({ seqs: { app: 1 } }) });
  assert.deepEqual(doc.scopes.app.records, { "bm:x": record });
});

test("a checkpoint from a newer app, or one whose scopes are damaged, reads as empty instead of throwing", async () => {
  assert.deepEqual((await opening({ docs: { "sync-state.nns": sealed({ version: 9, covers: 1, scopes: { app: scope } }) } })).doc.scopes.app?.records ?? {}, {});
  const { doc } = await opening({ docs: { "sync-state.nns": sealed({ version: 1, covers: 1, scopes: { app: "broken", other: { records: null } } }) } });
  assert.deepEqual(doc.scopes.app?.records ?? {}, {});
  assert.equal(doc.scopes.other, undefined);
});

test("a journal part from a newer app is skipped, and the parts after it still load", async () => {
  const { doc } = await opening({
    docs: {
      "sync-journal-1.nns": sealed({ id: 1, journal: { app: [batch(1)] }, version: 9 }),
      "sync-journal-2.nns": sealed({ id: 2, journal: { app: [batch(2)] }, version: 1 }),
    },
  });
  assert.deepEqual(Object.keys(doc.scopes.app.records), ["bm:2"]);
});

test("each batch is sealed into its own numbered part, and the state isn't rewritten", async () => {
  const { files } = await opening();
  for (const seq of [1, 2, 3]) await files.persistJournal("app")([batch(seq)]);
  files.save();
  assert.deepEqual(parts(), ["sync-journal-1.nns", "sync-journal-2.nns", "sync-journal-3.nns"]);
  assert.deepEqual(opened("sync-journal-2.nns").journal.app.map((f) => f.seq), [2]);
  assert.ok(!shell.docs.has("sync-state.nns"));
});

test("20,000 batches restored from the journal and handed over again are each kept once, without a scan per batch", async () => {
  const count = 20_000;
  const all = Array.from({ length: count }, (_, i) => batch(i + 1));
  const some = Array.prototype.some;
  let scanned = 0;
  Array.prototype.some = function (...args) {
    scanned += this.length;
    return some.apply(this, args);
  };
  let doc;
  try {
    let files;
    ({ doc, files } = await opening({
      docs: {
        "sync-journal-1.nns": sealed({ id: 1, journal: { app: all }, version: 1 }),
        "sync-journal-2.nns": sealed({ id: 2, journal: { app: all.slice(count / 2) }, version: 1 }),
      },
    }));
    await files.persistJournal("app")(all);
  } finally {
    Array.prototype.some = some;
  }
  assert.equal(doc.scopes.app.journal.length, count);
  assert.equal(parts().length, 2, "nothing new to write");
  assert.ok(scanned < 10 * count, `${scanned} list entries scanned`);
});

test("a batch handed over twice is written once", async () => {
  const { files } = await opening();
  await files.persistJournal("app")([batch(1)]);
  await files.persistJournal("app")([batch(1)]);
  assert.equal(parts().length, 1);
});

test("the full state is saved after an hour, and the parts it covers are removed newest first", async () => {
  const { doc, files } = await opening();
  for (const seq of [1, 2, 3]) await files.persistJournal("app")([batch(seq)]);
  doc.scopes.app = { ...emptyScope(), seq: 3 };
  files.save();
  await tick();
  assert.ok(!shell.docs.has("sync-state.nns"), "not before the hour");
  const removed = [];
  const remove = shell.docs.delete.bind(shell.docs);
  shell.docs.delete = (name) => (removed.push(name), remove(name));
  try {
    await afterAnHour(async () => {
      files.save();
      await tick();
    });
  } finally {
    delete shell.docs.delete;
  }
  assert.equal(opened("sync-state.nns").scopes.app.seq, 3);
  assert.deepEqual(removed, ["sync-journal-3.nns", "sync-journal-2.nns", "sync-journal-1.nns"]);
});

test("the full state is saved once the journal reaches 400 parts or 1 MB", async () => {
  {
    const { doc, files } = await opening();
    for (let seq = 1; seq <= 400; seq++) await files.persistJournal("app")([batch(seq)]);
    doc.scopes.app = { ...emptyScope(), seq: 400 };
    files.save();
    await tick();
    assert.ok(shell.docs.has("sync-state.nns"), "400 parts");
    assert.equal(parts().length, 0);
  }
  {
    const { doc, files } = await opening();
    await files.persistJournal("app")([batch(1, [{ k: "bm:big", h: "000000001.0000.devA", v: { t: "x".repeat(1_000_100) } }])]);
    doc.scopes.app = { ...emptyScope(), seq: 1 };
    files.save();
    await tick();
    assert.ok(shell.docs.has("sync-state.nns"), "1 MB");
  }
});

test("a batch not yet in the folder survives a checkpoint that clears its part, and a restart", async () => {
  const { doc, files } = await opening();
  await files.persistJournal("app")([batch(1)]);
  await files.persistJournal("app")([batch(2)]);
  const mine = (seq) => ({ h: `00000000${seq}.0000.devA`, v: { t: `B${seq}` }, o: ["devA", seq] });
  doc.scopes.app = { ...emptyScope(), seq: 2, journal: [batch(2)], records: { "bm:1": mine(1), "bm:2": mine(2) } };
  await afterAnHour(async () => {
    files.save();
    await tick();
  });
  assert.ok(shell.docs.has("sync-state.nns"));
  assert.equal(parts().length, 0);
  const { doc: after } = await restart(doc);
  assert.ok("bm:2" in after.scopes.app.records);
  assert.deepEqual(after.scopes.app.journal?.map((f) => f.seq), [2], "and it's still to be written");
});

test("the old single journal is replayed first and emptied with the parts", async () => {
  const { doc, files } = await opening({ docs: { "sync-journal.nns": sealed({ journal: { app: [batch(1)] } }), "sync-journal-1.nns": sealed({ id: 5, journal: { app: [batch(2)] }, version: 1 }) } });
  assert.deepEqual(Object.keys(doc.scopes.app.records).sort(), ["bm:1", "bm:2"]);
  doc.scopes.app.journal = undefined;
  await afterAnHour(async () => {
    files.save();
    await tick();
  });
  assert.equal(shell.docs.get("sync-journal.nns"), "");
  assert.equal(parts().length, 0);
});

test("sync.json isn't rewritten for lastSyncedAt alone within five minutes, and is for anything else", async () => {
  const doc = newDoc();
  shell.docs.clear();
  const files = syncFiles(() => doc);
  let writes = 0;
  const set = shell.docs.set.bind(shell.docs);
  shell.docs.set = (name, contents) => (name === "sync.json" && writes++, set(name, contents));
  try {
    files.save();
    assert.equal(writes, 1);
    doc.lastSyncedAt = 1;
    files.save();
    assert.equal(writes, 1, "not for lastSyncedAt alone");
    doc.folder = "/elsewhere";
    files.save();
    assert.equal(writes, 2, "a real change is written at once");
    doc.lastSyncedAt = 2;
    Date.now = () => realNow() + 5 * 60_000 + 1;
    files.save();
    assert.equal(writes, 3, "and lastSyncedAt after five minutes");
  } finally {
    Date.now = realNow;
    delete shell.docs.set;
  }
});

test("before the state is loaded nothing rewrites it, quitting included, unless sync starts over", async () => {
  shell.docs.clear();
  shell.docs.set("sync-state.nns", sealed({ covers: -1, scopes: { app: scope }, version: 1 }));
  const doc = newDoc();
  const files = syncFiles(() => doc);
  await afterAnHour(async () => {
    files.save();
    files.checkpoint();
    await tick();
  });
  assert.deepEqual(opened("sync-state.nns").scopes.app.records, { "bm:x": record });
  doc.enabled = false;
  startOver(files);
  await tick();
  assert.equal(shell.docs.get("sync-state.nns"), "");
});

test("starting over on a new device seals an empty state at once and drops every part", async () => {
  const { doc, files } = await opening({ docs: { "sync-journal-1.nns": sealed({ id: 1, journal: { app: [batch(1)] }, version: 1 }) } });
  doc.scopes = {};
  startOver(files);
  await tick();
  assert.deepEqual(opened("sync-state.nns").scopes, {});
  assert.equal(parts().length, 0);
});

test("what a scope's sync applied is journaled for this device, and a restart replays it only for linked scopes", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  const clock = new Clock("devA");
  for (const name of ["app", "p:s1", "p:gone"]) {
    const state = (doc.scopes[name] = emptyScope());
    const settled = files.watchScope(name, state, clock);
    putRecord(state, "bm:r", { h: "000000009.0000.devB", v: { t: "Remote" }, o: ["devB", 1] });
    putBase(state, "bm:r", '{"t":"Remote"}');
    state.vv = { devB: 1 };
    await settled();
  }
  shell.docs.set("sync-journal-99.nns", sealed({ id: Date.now() + 1, device: "devZ", changes: { app: { records: { "bm:z": record }, base: {}, rest: {} } }, version: 1 }));
  const { doc: after } = await restart(doc);
  assert.deepEqual(after.scopes.app.records["bm:r"].v, { t: "Remote" });
  assert.equal(after.scopes.app.base["bm:r"], '{"t":"Remote"}');
  assert.deepEqual(after.scopes.app.vv, { devB: 1 });
  assert.ok("bm:r" in after.scopes["p:s1"].records);
  assert.ok(!after.scopes["p:gone"]?.records["bm:r"], "a scope no longer linked isn't brought back");
  assert.ok(!("bm:z" in after.scopes.app.records), "another device's part isn't replayed");
  assert.deepEqual(after.scopes.app.unapplied, [], "replayed keys load as applied");
});

const batchOf = (id, keys, extra = {}) => ({ id, p: "bm:", l: "launch-1", at: 5, k: keys, ...extra });

test("a batch about to be applied is on disk before the apply, survives a restart mid-cycle, and the cycle's own part keeps only the batches still live", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  const state = (doc.scopes["p:s1"] = emptyScope());
  putBase(state, "bm:t1", '{"t":"T1"}');
  const first = batchOf(10, { "bm:t1": ['{"t":"T1"}', '"fp1"'] });
  const second = batchOf(11, { "bm:t2": [null, '"fp2"'] });
  const before = parts().length;
  await files.persistApplying("p:s1")(first);
  await files.persistApplying("p:s1")(second);
  assert.equal(parts().length, before + 2, "written at once, not at the end of the cycle");
  const { doc: killed } = await restart(doc);
  assert.deepEqual(killed.scopes["p:s1"].applying, [first, second]);
  const settled = files.watchScope("p:s1", state, new Clock("devA"));
  state.applying = [second];
  await settled();
  const written = opened(parts().at(-1));
  assert.deepEqual(written.changes["p:s1"].rest.applyingIds, [11], "the cycle's part names its batches, it doesn't copy them");
  assert.equal(written.changes["p:s1"].rest.applying, undefined);
  const { doc: after } = await restart(doc);
  assert.deepEqual(after.scopes["p:s1"].applying, [second]);
});

test("the full state waits while a batch is live, for two minutes at most", async () => {
  const doc = newDoc();
  const { files } = await opening({ doc });
  doc.scopes.app = { ...emptyScope(), applying: [batchOf(40, { "bm:x": [null, '"fp"'] })] };
  const at = (ms, fn) => {
    Date.now = () => realNow() + ms;
    return Promise.resolve(fn()).finally(() => (Date.now = realNow));
  };
  await at(HOUR + 1, async () => (files.save(), await tick()));
  assert.equal(shell.docs.has("sync-state.nns"), false);
  await at(HOUR + 2 * 60_000 + 2, async () => (files.save(), await tick()));
  assert.ok(opened("sync-state.nns").scopes.app.applying.length);
});

test("a batch too big for one part is split across parts under the limit and read back whole", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  doc.scopes["p:s1"] = emptyScope();
  const keys = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`h:https://example.com/a/fairly/long/path/${i}`, [null, `"fp${i}"`]]));
  const before = parts().length;
  await files.persistApplying("p:s1")(batchOf(20, keys));
  const written = parts().slice(before);
  assert.ok(written.length > 1);
  for (const name of written) assert.ok(shell.docs.get(name).length < 8 * 1024 * 1024 / 2, `${name} stays well under the 8 MiB journal limit`);
  const { doc: after } = await restart(doc);
  assert.equal(Object.keys(after.scopes["p:s1"].applying[0].k).length, 100_000);
});

test("a batch whose parts weren't all written is never loaded", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  doc.scopes["p:s1"] = emptyScope();
  const keys = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`h:https://example.com/a/fairly/long/path/${i}`, [null, `{"t":"${i}"}`]]));
  sealHook = async (text) => {
    if (text.includes('"i":1')) throw new Error("killed mid-write");
    return `sealed:${text}`;
  };
  await assert.rejects(files.persistApplying("p:s1")(batchOf(50, keys)));
  sealHook = null;
  const { doc: after } = await restart(doc);
  assert.equal(after.scopes["p:s1"]?.applying, undefined);
});

test("keys a batch no longer covers, and its residual mark, stay that way across restarts", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  const state = (doc.scopes["p:s1"] = emptyScope());
  const full = batchOf(60, { "bm:a": ['{"t":"A"}', '{"t":"B"}'], "bm:b": ['{"t":"X"}', '{"t":"Y"}'], "bm:c": [null, '{"t":"Z"}'] });
  await files.persistApplying("p:s1")(full);
  const settled = files.watchScope("p:s1", state, new Clock("devA"));
  const trimmed = { ...full, r: 1, f: 1, ok: 1, cut: ["bm:a", "bm:c"], k: { "bm:b": full.k["bm:b"] } };
  state.applying = [trimmed];
  await settled();
  const { doc: once } = await restart(doc);
  assert.deepEqual(once.scopes["p:s1"].applying, [trimmed]);
  const { doc: twice } = await restart(once);
  assert.deepEqual(twice.scopes["p:s1"].applying, [trimmed]);
});

test("a cycle part that drops one key of a 100,000-key batch names that key, not the rest", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  const state = (doc.scopes["p:s1"] = emptyScope());
  const keys = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`h:https://example.com/a/fairly/long/path/${i}`, [null, `{"t":"${i}"}`]]));
  const full = batchOf(70, keys);
  await files.persistApplying("p:s1")(full);
  const settled = files.watchScope("p:s1", state, new Clock("devA"));
  const { "h:https://example.com/a/fairly/long/path/0": _gone, ...left } = keys;
  state.applying = [{ ...full, r: 1, cut: ["h:https://example.com/a/fairly/long/path/0"], k: left }];
  await settled();
  assert.ok(shell.docs.get(parts().at(-1)).length < 10_000, "the cycle part stays small");
  const { doc: after } = await restart(doc);
  assert.equal(Object.keys(after.scopes["p:s1"].applying[0].k).length, 99_999);
  assert.ok(!("h:https://example.com/a/fairly/long/path/0" in after.scopes["p:s1"].applying[0].k));
});

test("a batch retired with an empty write is gone after a restart, and steps that aren't JSON are dropped", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const { files } = await opening({ doc });
  doc.scopes["p:s1"] = emptyScope();
  const kept = batchOf(80, { "bm:a": ['{"t":"A"}', '{"t":"B"}'] });
  await files.persistApplying("p:s1")(kept);
  await files.persistApplying("p:s1")(batchOf(81, { "bm:b": [null, '{"t":"B"}'] }));
  await files.persistApplying("p:s1")(batchOf(81, {}));
  await files.persistApplying("p:s1")(batchOf(82, { "bm:c": ["{not json", '{"t":"C"}'] }));
  const { doc: after } = await restart(doc);
  assert.deepEqual(after.scopes["p:s1"].applying, [kept]);
});

test("a trim whose kept or cut list isn't a list of keys is ignored, and the state still loads", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const good = batchOf(30, { "bm:t1": ['{"t":"T1"}', '"fp1"'] });
  const checkpoint = { covers: 0, scopes: { "p:s1": { ...emptyScope(), applying: [good] } }, version: 1 };
  await opening({ doc, docs: { "sync-state.nns": sealed(checkpoint) } });
  for (const trim of [{ k: 1, e: [] }, { k: [], e: 1 }, { e: [2] }, {}]) {
    const next = parts().length + 1;
    shell.docs.set(`sync-journal-${next}.nns`, sealed({ id: Date.now() + next, device: "devA", changes: { "p:s1": { records: {}, base: {}, rest: { applyingIds: [30], applyingTrimmed: { 30: trim } } } }, version: 1 }));
    const { doc: after } = await restart(doc);
    assert.deepEqual(after.scopes["p:s1"].applying, [good], JSON.stringify(trim));
    shell.docs.delete(`sync-journal-${next}.nns`);
  }
});

test("damaged batches in a part, a checkpoint or a cycle's part are dropped instead of stalling sync", async () => {
  const doc = newDoc({ profiles: { default: { syncId: "s1", enabled: true } } });
  const good = batchOf(30, { "bm:t1": ['{"t":"T1"}', '"fp1"'] });
  const checkpoint = { covers: 0, scopes: { "p:s1": { ...emptyScope(), applying: [null, good, { id: "x" }, batchOf(31, { "bm:t2": [3, '"fp"'] })] } }, version: 1 };
  const { files } = await opening({ doc, docs: { "sync-state.nns": sealed(checkpoint) } });
  assert.deepEqual(doc.scopes["p:s1"].applying, [good]);
  const next = parts().length + 1;
  shell.docs.set(`sync-journal-${next}.nns`, sealed({ id: Date.now() + 1, device: "devA", applying: { "p:s1": [null, { id: 32 }, batchOf(33, { "bm:t3": [null, '"fp3"'] })] }, version: 1 }));
  shell.docs.set(`sync-journal-${next + 1}.nns`, sealed({ id: Date.now() + 2, device: "devA", changes: { "p:s1": { records: {}, base: {}, rest: { applying: { "bm:t1": null }, applyingIds: [30, "33", null] } } }, version: 1 }));
  const { doc: after } = await restart(doc);
  assert.deepEqual(after.scopes["p:s1"].applying, undefined, "ids that aren't a list of numbers keep no batch");
  shell.docs.set(`sync-journal-${next + 1}.nns`, sealed({ id: Date.now() + 2, device: "devA", changes: { "p:s1": { records: {}, base: {}, rest: { applying: { "bm:t1": null }, applyingIds: [30, 33] } } }, version: 1 }));
  const { doc: again } = await restart(doc);
  assert.deepEqual(again.scopes["p:s1"].applying.map((b) => b.id), [30, 33]);
  assert.ok(files);
});

test("a scope's sync that changed nothing writes no part; one that changed only its bookkeeping does", async () => {
  const { doc, files } = await opening();
  const state = (doc.scopes.app = emptyScope());
  const clock = new Clock("devA");
  await files.watchScope("app", state, clock)();
  const first = parts().length;
  await files.watchScope("app", state, clock)();
  assert.equal(parts().length, first, "nothing new, nothing written");
  const settled = files.watchScope("app", state, clock);
  state.unapplied = ["set:x"];
  await settled();
  assert.equal(parts().length, first + 1);
});

test("a scope replaced while it synced isn't journaled", async () => {
  const { doc, files } = await opening();
  const state = (doc.scopes.app = emptyScope());
  const settled = files.watchScope("app", state, new Clock("devA"));
  putRecord(state, "bm:r", record);
  doc.scopes.app = emptyScope();
  await settled();
  assert.equal(parts().length, 0);
});

test("a changes part that fails to save makes the next save write the full state", async () => {
  const { doc, files } = await opening();
  const state = (doc.scopes.app = emptyScope());
  sealHook = async (text) => {
    if (text.includes('"changes"')) throw new Error("disk full");
    return `sealed:${text}`;
  };
  try {
    const settled = files.watchScope("app", state, new Clock("devA"));
    putRecord(state, "bm:r", record);
    await settled();
  } finally {
    sealHook = null;
  }
  assert.equal(parts().length, 0);
  files.save();
  await tick();
  assert.ok("bm:r" in opened("sync-state.nns").scopes.app.records);
});

test("a batch part that fails to save keeps its number, isn't kept in memory, and is written on retry", async () => {
  const { doc, files } = await opening();
  await files.persistJournal("app")([batch(1)]);
  sealHook = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(files.persistJournal("app")([batch(2)]));
  sealHook = null;
  await files.persistJournal("app")([batch(2)]);
  assert.deepEqual(parts(), ["sync-journal-1.nns", "sync-journal-2.nns"]);
  assert.deepEqual(opened("sync-journal-2.nns").journal.app.map((f) => f.seq), [2]);
  const { doc: after } = await restart(doc);
  assert.ok("bm:2" in after.scopes.app.records, "a restart reads past it");
});

test("part ids only grow, and loading skips parts the saved state already covers", async () => {
  const { files } = await opening();
  await files.persistJournal("app")([batch(1)]);
  await files.persistJournal("app")([batch(2)]);
  const [one, two] = parts().map((n) => opened(n).id);
  assert.ok(two > one && one >= realNow() - 60_000, "ids grow from the wall time");
  const covered = { id: 5, device: "devA", changes: { app: { records: { "bm:old": record }, base: {}, rest: {} } } };
  const later = { id: 6, device: "devA", changes: { app: { records: { "bm:new": record }, base: {}, rest: {} } } };
  const { doc } = await opening({
    docs: {
      "sync-state.nns": sealed({ covers: 5, scopes: { app: emptyScope() }, version: 1 }),
      "sync-journal-1.nns": sealed({ ...covered, version: 1 }),
      "sync-journal-2.nns": sealed({ ...later, version: 1 }),
    },
  });
  assert.deepEqual(Object.keys(doc.scopes.app.records), ["bm:new"]);
  const { doc: unmarked } = await opening({
    docs: {
      "sync-state.nns": sealed({ app: emptyScope() }),
      "sync-journal-1.nns": sealed({ ...covered, version: 1 }),
      "sync-journal-2.nns": sealed({ ...later, version: 1 }),
    },
  });
  assert.deepEqual(Object.keys(unmarked.scopes.app.records).sort(), ["bm:new", "bm:old"], "a state without covers replays every part");
});

test("loading raises the clock past the saved state's, the parts' and every restored record's", async () => {
  const late = (wall) => `${wall.toString(36).padStart(9, "0")}.0000.devB`;
  const cases = [
    { docs: { "sync-state.nns": sealed({ covers: -1, clock: late(500), scopes: {}, version: 1 }) }, want: 500 },
    { docs: { "sync-journal-1.nns": sealed({ id: 1, device: "devA", clock: late(600), changes: { app: { records: {}, base: {}, rest: {} } }, version: 1 }) }, want: 600 },
    { docs: { "sync-state.nns": sealed({ covers: -1, scopes: { app: { ...emptyScope(), records: { "bm:x": { ...record, h: late(700) } } } }, version: 1 }) }, want: 700 },
  ];
  for (const { docs, want } of cases) {
    const { doc } = await opening({ docs, doc: newDoc({ clock: late(100).replace("devB", "devA") }) });
    assert.equal(parseInt(doc.clock.slice(0, 9), 36), want);
  }
});

test("the saved state keeps the clock the running cycle has seen", async () => {
  const { doc, files } = await opening();
  const clock = new Clock("devA");
  clock.observe("00000zzzz.0000.devB");
  const state = (doc.scopes.app = emptyScope());
  files.watchScope("app", state, clock);
  startOver(files);
  await tick();
  assert.ok(opened("sync-state.nns").clock >= "00000zzzz", "sealed with the newer clock");
});

test("a part written while the state seals isn't removed with the parts the state covers", async () => {
  const { doc, files } = await opening();
  await files.persistJournal("app")([batch(1)]);
  doc.scopes.app = { ...emptyScope(), seq: 1, records: { "bm:1": { h: "000000001.0000.devA", v: { t: "B1" }, o: ["devA", 1] } } };
  const seal = await sealHeld((text) => text.startsWith('{"covers"'));
  await afterAnHour(async () => {
    files.save();
    await tick();
  });
  assert.ok(seal.waiting(), "the state is sealing");
  const state = doc.scopes.app;
  const settled = files.watchScope("app", state, new Clock("devA"));
  putRecord(state, "bm:during", record);
  const writing = settled();
  await tick();
  seal.release();
  await writing;
  await tick();
  const { doc: after } = await restart(doc);
  assert.ok("bm:during" in after.scopes.app.records, "the change made during the seal survives a restart");
});

test("sync turned off while the state seals leaves an empty state file", async () => {
  const { doc, files } = await opening();
  doc.scopes.app = { ...emptyScope(), records: { "bm:1": record } };
  const seal = await sealHeld((text) => text.startsWith('{"covers"'));
  await afterAnHour(async () => {
    files.save();
    await tick();
  });
  assert.ok(seal.waiting());
  doc.enabled = false;
  startOver(files);
  seal.release();
  await tick();
  assert.equal(shell.docs.get("sync-state.nns"), "");
});

test("quitting waits for a part still sealing and the checkpoint queued behind it, up to a deadline", async () => {
  const { finishQuitSaves, saveBeforeQuit } = await import("../app/quit.ts");
  const { doc, files } = await opening();
  saveBeforeQuit(files.checkpoint);
  const seal = await sealHeld((text) => text.includes('"journal"'));
  doc.scopes.app = { ...emptyScope(), seq: 1, journal: [batch(1)] };
  const persisting = files.persistJournal("app")([batch(1)]);
  await tick();
  assert.ok(seal.waiting(), "the part is sealing");
  let quit = false;
  const quitting = finishQuitSaves(5_000).then(() => (quit = true));
  await tick();
  assert.ok(!quit, "quitting waits");
  seal.release();
  await persisting;
  await quitting;
  assert.ok(shell.docs.has("sync-state.nns"), "the checkpoint landed before the quit went ahead");
  assert.deepEqual(opened("sync-state.nns").scopes.app.journal.map((f) => f.seq), [1]);

  const stuck = await sealHeld(() => true);
  const started = realNow();
  await finishQuitSaves(50);
  assert.ok(realNow() - started < 2_000, "a save that never ends doesn't hold the quit past the deadline");
  stuck.release();
});

test("a checkpoint queued behind a part still sealing covers that part, with the clock seen by then", async () => {
  const { doc, files } = await opening();
  const state = (doc.scopes.app = emptyScope());
  const clock = new Clock("devA");
  const seal = await sealHeld((text) => text.includes('"changes"'));
  const settled = files.watchScope("app", state, clock);
  putRecord(state, "bm:r", record);
  const writing = settled();
  await tick();
  assert.ok(seal.waiting());
  await afterAnHour(async () => {
    files.save();
    clock.observe("00000zzzz.0000.devB");
    seal.release();
    await writing;
    await tick();
  });
  const saved = opened("sync-state.nns");
  assert.ok("bm:r" in saved.scopes.app.records, "the snapshot is taken when the checkpoint runs");
  assert.ok(saved.clock >= "00000zzzz", "with the clock as it was then");
  assert.equal(parts().length, 0, "and the part it covers is removed");
  const { doc: after } = await restart(doc);
  assert.ok("bm:r" in after.scopes.app.records);
});
