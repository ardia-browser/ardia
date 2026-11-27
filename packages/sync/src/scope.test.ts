import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock } from "./hlc.ts";
import { compact, restoreJournal, startRebase, syncScope } from "./scope.ts";
import { emptyScope, type Adapter, type Listing, type LogFile, type ScopeOptions, type ScopeState, type Transport } from "./scopeState.ts";

type Entry = { payload: string; hiddenFrom: Set<string>; partialFor: Set<string>; at: number };
class Folder {
  scopes = new Map<string, Map<string, Entry>>();
  counter = 0;
  now = 0;
  scope(name: string) {
    let s = this.scopes.get(name);
    if (!s) this.scopes.set(name, (s = new Map()));
    return s;
  }
  transport(device: string): Transport {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.scope(scope).set(id, { payload, hiddenFrom: new Set(), partialFor: new Set(), at: this.now });
        return id;
      },
      read: async (scope, known): Promise<Listing> => {
        const listing: Listing = { files: [], pending: [], damaged: [], present: [] };
        for (const [id, e] of this.scope(scope)) {
          listing.present.push(id);
          if (known.includes(id)) continue;
          if (e.hiddenFrom.has(device)) listing.pending.push(id);
          else if (e.partialFor.has(device)) listing.damaged.push({ id, age: 0 });
          else listing.files.push({ id, payload: e.payload });
        }
        return listing;
      },
      remove: async (scope, ids) => {
        for (const id of ids) this.scope(scope).delete(id);
      },
    };
  }
  fileCount(scope = "s") {
    return this.scope(scope).size;
  }
}

class Device {
  store = new Map<string, unknown>();
  settings = new Map<string, unknown>();
  state: ScopeState = emptyScope();
  clock: Clock;
  offset = 0;
  onRead?: () => void;
  afterRead?: () => Promise<void>;
  failWrite?: "before" | "after";
  readonly id: string;
  readonly folder: Folder;
  readonly options: ScopeOptions;
  constructor(id: string, folder: Folder, options: ScopeOptions = {}) {
    this.id = id;
    this.folder = folder;
    this.options = options;
    this.clock = new Clock(id, null, () => this.time());
  }
  time() {
    return this.folder.now + this.offset;
  }
  adapters(): Adapter[] {
    return [
      {
        prefix: "x:",
        extract: () => ({ values: new Map(this.store) }),
        apply: (visible, changed) => {
          for (const k of changed) visible.has(k) ? this.store.set(k, visible.get(k)) : this.store.delete(k);
        },
      },
      {
        prefix: "set:",
        adoptRemoteOnJoin: true,
        extract: () => ({ values: new Map(this.settings) }),
        apply: (visible, changed) => {
          for (const k of changed) if (visible.has(k)) this.settings.set(k, visible.get(k));
        },
      },
    ];
  }
  async sync() {
    const base = this.folder.transport(this.id);
    const transport: Transport = {
      ...base,
      write: async (scope, payload) => {
        const fail = this.failWrite;
        delete this.failWrite;
        if (fail === "before") throw new Error("offline");
        const id = await base.write(scope, payload);
        if (fail === "after") throw new Error("timed out");
        return id;
      },
      read: async (scope, known) => {
        const listing = await base.read(scope, known);
        this.onRead?.();
        await this.afterRead?.();
        return listing;
      },
    };
    return syncScope({
      scope: "s",
      state: this.state,
      transport,
      adapters: this.adapters(),
      clock: this.clock,
      device: this.id,
      now: () => this.time(),
      options: { pruneGrace: 0, persist: async (batches) => this.persist(batches), ...this.options },
    });
  }
  relaunch() {
    this.state = JSON.parse(JSON.stringify(this.state)) as ScopeState;
    this.clock = new Clock(this.id, this.clock.last, () => this.time());
  }
  saved = JSON.stringify(emptyScope());
  savedClock: string | null = null;
  journal = new Map<number, LogFile>();
  persist(batches: LogFile[]) {
    for (const f of batches) this.journal.set(f.seq, JSON.parse(JSON.stringify(f)) as LogFile);
  }
  save() {
    this.saved = JSON.stringify(this.state);
    this.savedClock = this.clock.last;
    for (const seq of this.journal.keys()) if (seq <= this.state.seq) this.journal.delete(seq);
  }
  crash() {
    this.state = JSON.parse(this.saved) as ScopeState;
    this.clock = new Clock(this.id, this.savedClock, () => this.time());
    restoreJournal(this.state, [...this.journal.values()], this.clock);
  }
}

const snapshot = (d: Device) => Object.fromEntries([...d.store].sort(([a], [b]) => a.localeCompare(b)));
async function syncAll(devices: Device[], rounds = 2) {
  for (let i = 0; i < rounds; i++) for (const d of devices) await d.sync();
}

test("concurrent edits converge on the newest, whatever order devices sync in", async () => {
  for (const order of [["devA", "devB"], ["devB", "devA"]]) {
    const folder = new Folder();
    const a = new Device("devA", folder);
    const b = new Device("devB", folder);
    a.store.set("x:k", "base");
    await syncAll([a, b]);
    folder.now += 10;
    a.store.set("x:k", "A's edit");
    folder.now += 10;
    b.store.set("x:k", "B's edit (later)");
    const devices = order.map((id) => (id === "devA" ? a : b));
    await syncAll(devices, 3);
    assert.deepEqual(snapshot(a), snapshot(b));
    assert.equal(a.store.get("x:k"), "B's edit (later)");
    assert.deepEqual(a.state.records, b.state.records);
  }
});

test("deletes propagate; a re-add after a delete wins; an edit after a delete wins", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  a.store.set("x:1", "one");
  a.store.set("x:2", "two");
  await syncAll([a, b]);
  folder.now += 5;
  b.store.delete("x:1");
  await syncAll([b, a]);
  assert.equal(a.store.has("x:1"), false);
  folder.now += 5;
  a.store.set("x:1", "one again");
  await syncAll([a, b]);
  assert.equal(b.store.get("x:1"), "one again");
  folder.now += 5;
  a.store.delete("x:2");
  folder.now += 5;
  b.store.set("x:2", "two, edited");
  await syncAll([a, b, a]);
  assert.equal(a.store.get("x:2"), "two, edited");
  assert.deepEqual(snapshot(a), snapshot(b));
});

test("clock skew: an edit made after seeing another device's wins even with a slow clock", async () => {
  const folder = new Folder();
  folder.now = 10_000_000;
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  b.offset = -3_600_000;
  a.store.set("x:k", "A");
  await syncAll([a, b]);
  assert.equal(b.store.get("x:k"), "A");
  folder.now += 1000;
  b.store.set("x:k", "B, after seeing A");
  await syncAll([b, a]);
  assert.equal(a.store.get("x:k"), "B, after seeing A");
  const c = new Device("devC", folder);
  c.offset = 3 * 86_400_000;
  c.store.set("x:k", "C from the future");
  await syncAll([c, a, b]);
  assert.equal(a.store.get("x:k"), "C from the future");
  folder.now += 1000;
  a.store.set("x:k", "A, after C");
  await syncAll([a, b, c]);
  for (const d of [a, b, c]) assert.equal(d.store.get("x:k"), "A, after C");
});

test("files arriving late, out of order or cut short are read when they're whole", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  a.store.set("x:1", "v1");
  await a.sync();
  a.store.set("x:1", "v2");
  a.store.set("x:2", "second");
  await a.sync();
  const [first, second] = [...folder.scope("s").values()];
  first!.hiddenFrom.add("devB");
  second!.partialFor.add("devB");
  const r = await b.sync();
  assert.equal(r.pending, 1);
  assert.equal(b.store.size, 0);
  assert.equal(Object.keys(b.state.damaged).length, 1);
  second!.partialFor.clear();
  await b.sync();
  assert.deepEqual(snapshot(b), { "x:1": "v2", "x:2": "second" });
  assert.equal(b.state.vv.devA ?? 0, 0);
  assert.deepEqual(b.state.extra.devA, [2]);
  first!.hiddenFrom.clear();
  await b.sync();
  assert.deepEqual(snapshot(b), { "x:1": "v2", "x:2": "second" });
  assert.equal(b.state.vv.devA, 2);
  assert.equal(b.state.extra.devA, undefined);
});

test("a local edit made while files are read isn't overwritten", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  a.store.set("x:k", "old");
  await syncAll([a, b]);
  folder.now += 10;
  a.store.set("x:k", "A remote");
  await a.sync();
  folder.now += 10;
  b.onRead = () => {
    b.store.set("x:k", "B, typed during the read");
    b.onRead = undefined;
  };
  await b.sync();
  assert.equal(b.store.get("x:k"), "B, typed during the read");
  await syncAll([a, b]);
  assert.equal(a.store.get("x:k"), "B, typed during the read");
});

test("three devices, random edits, sync orders and crashes, converge", async () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let compactions = 0;
  for (let run = 0; run < 40; run++) {
    const folder = new Folder();
    const opts = { compactAfterFiles: 6, compactInterval: 0 };
    const devices = ["devA", "devB", "devC"].map((id) => new Device(id, folder, opts));
    for (let step = 0; step < 40; step++) {
      folder.now += Math.floor(random() * 50);
      const d = devices[Math.floor(random() * 3)]!;
      const key = `x:${Math.floor(random() * 6)}`;
      const r = random();
      if (r < 0.5) d.store.set(key, `${d.id}-${step}`);
      else if (r < 0.7) d.store.delete(key);
      else if (r < 0.75) d.relaunch();
      else if (r < 0.8) d.crash();
      else await d.sync();
      if (random() < 0.4) d.save();
      if (random() < 0.3) await devices[Math.floor(random() * 3)]!.sync();
      for (const e of folder.scope("s").values()) {
        if (random() < 0.15) e.hiddenFrom.add(devices[Math.floor(random() * 3)]!.id);
        if (random() < 0.1) e.partialFor.add(devices[Math.floor(random() * 3)]!.id);
        if (random() < 0.3) e.hiddenFrom.clear();
        if (random() < 0.3) e.partialFor.clear();
      }
    }
    for (const e of folder.scope("s").values()) {
      e.hiddenFrom.clear();
      e.partialFor.clear();
    }
    await syncAll(devices, 3);
    compactions += [...folder.scope("s").values()].filter((e) => e.payload.includes('"snapshot"')).length;
    const [a, b, c] = devices;
    assert.deepEqual(snapshot(a!), snapshot(b!), `run ${run}`);
    assert.deepEqual(snapshot(b!), snapshot(c!), `run ${run}`);
    assert.deepEqual(a!.state.records, b!.state.records, `run ${run}`);
  }
  assert.ok(compactions > 0);
});

test("an old snapshot put back after its tombstones were collected doesn't bring deleted records back", async () => {
  const folder = new Folder();
  const day = 86_400_000;
  const opts: ScopeOptions = { compactAfterFiles: 1000, compactInterval: 0, tombstoneTTL: 7 * day };
  const a = new Device("devA", folder, opts);
  const b = new Device("devB", folder, opts);
  a.store.set("x:keep", 1);
  a.store.set("x:secret", "hunter2");
  await syncAll([a, b]);
  await compact(a.state, folder.transport("devA"), "s", "devA", folder.now, { ...opts, pruneGrace: 0 }, true);
  const [oldId, old] = [...folder.scope("s")].find(([, e]) => e.payload.includes('"snapshot"'))!;
  assert.ok(old.payload.includes("hunter2"));
  folder.now += day;
  a.store.delete("x:secret");
  await syncAll([a, b]);
  assert.equal(b.store.has("x:secret"), false);
  folder.now += 30 * day;
  a.store.set("x:later", 3);
  await syncAll([a, b]);
  for (const d of [a, b]) await compact(d.state, folder.transport(d.id), "s", d.id, folder.now, { ...opts, pruneGrace: 0 }, true);
  for (const d of [a, b]) assert.equal(d.state.records["x:secret"], undefined, `${d.id} collected the tombstone`);
  assert.equal(folder.scope("s").has(oldId), false);

  folder.scope("s").set(oldId, { ...old, hiddenFrom: new Set(), partialFor: new Set() });
  await syncAll([a, b]);
  assert.equal(a.store.has("x:secret"), false, "A");
  assert.equal(b.store.has("x:secret"), false, "B");
  const c = new Device("devC", folder, opts);
  const entries = [...folder.scope("s")];
  folder.scopes.set("s", new Map([...entries.filter(([id]) => id !== oldId), [oldId, { ...old, hiddenFrom: new Set<string>(), partialFor: new Set<string>() }]]));
  await c.sync();
  assert.equal(c.store.has("x:secret"), false, "C");
  assert.deepEqual(snapshot(c), snapshot(a));
});

test("a tombstone outlives its age limit while an older log is still missing", async () => {
  const folder = new Folder();
  const day = 86_400_000;
  const opts: ScopeOptions = { compactAfterFiles: 1000, compactInterval: 0, tombstoneTTL: 7 * day };
  const a = new Device("devA", folder, opts);
  const b = new Device("devB", folder, opts);
  a.store.set("x:gone", "old");
  await a.sync();
  a.store.delete("x:gone");
  await a.sync();
  const [first] = [...folder.scope("s").values()];
  first!.hiddenFrom.add("devB");
  await b.sync();
  assert.deepEqual(b.state.extra.devA, [2]);
  folder.now += 8 * day;
  await compact(b.state, folder.transport("devB"), "s", "devB", folder.now, opts, true);
  assert.equal(b.state.records["x:gone"]?.v, null, "kept while log 1 is missing");
  first!.hiddenFrom.clear();
  await b.sync();
  assert.equal(b.store.has("x:gone"), false);
  assert.equal(b.state.vv.devA, 2);
  await compact(b.state, folder.transport("devB"), "s", "devB", folder.now, opts, true);
  assert.equal(b.state.records["x:gone"], undefined, "collected once nothing is missing");

  const c = new Device("devC", folder, opts);
  c.store.set("x:lost", "old");
  await c.sync();
  c.store.delete("x:lost");
  await c.sync();
  const lost = [...folder.scope("s").values()].find((e) => e.payload.includes('"devC"') && e.payload.includes('"old"'))!;
  lost.hiddenFrom.add("devB");
  await b.sync();
  folder.now += 8 * day;
  await compact(b.state, folder.transport("devB"), "s", "devB", folder.now, opts, true);
  assert.equal(b.state.records["x:lost"]?.v, null);
  folder.now += 7 * day;
  await compact(b.state, folder.transport("devB"), "s", "devB", folder.now, opts, true);
  assert.equal(b.state.records["x:lost"], undefined, "a log that never shows up holds tombstones for twice the limit at most");
});

test("a failed write is retried as the same batch, even when the file did land", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  for (const fail of ["after", "before"] as const) {
    a.store.set(`x:${fail}`, 1);
    a.failWrite = fail;
    await assert.rejects(a.sync());
    a.store.set(`x:${fail}-next`, 2);
    await syncAll([a, b]);
    assert.deepEqual(snapshot(b), snapshot(a), fail);
  }
  assert.equal(b.store.get("x:after-next"), 2);
  const files = [...folder.scope("s").values()].map((e) => e.payload);
  assert.equal(files.length, new Set(files).size + 1, "only the batch whose write threw after landing is there twice");
});

test("a local edit typed while files are read still wins over a deletion in that read", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  a.store.set("x:k", "old");
  await syncAll([a, b]);
  folder.now += 10;
  a.store.delete("x:k");
  await a.sync();
  folder.now += 10;
  b.onRead = () => {
    b.store.set("x:k", "B, typed during the read");
    b.onRead = undefined;
  };
  await b.sync();
  assert.equal(b.store.get("x:k"), "B, typed during the read");
  await syncAll([a, b]);
  assert.equal(a.store.get("x:k"), "B, typed during the read");
});

class Slow extends Device {
  pausedRead?: () => void;
  readings = 0;
  others = new Map<string, unknown>();
  override adapters(): Adapter[] {
    return [
      ...super.adapters(),
      {
        prefix: "y:",
        extract: async () => {
          this.readings++;
          this.pausedRead?.();
          return { values: new Map(this.others) };
        },
        apply: (visible, changed) => {
          for (const k of changed) visible.has(k) ? this.others.set(k, visible.get(k)) : this.others.delete(k);
        },
      },
    ];
  }
}

test("an edit made while another adapter reads, after a pull that deleted it, isn't lost", async () => {
  const folder = new Folder();
  const a = new Slow("devA", folder);
  const b = new Slow("devB", folder);
  a.store.set("x:k", "item");
  a.others.set("y:z", "other");
  await syncAll([a, b]);
  folder.now += 10;
  a.store.delete("x:k");
  a.others.delete("y:z");
  await a.sync();
  folder.now += 10;
  b.readings = 0;
  b.pausedRead = () => {
    if (b.readings !== 2) return;
    b.store.set("x:k", "B, renamed meanwhile");
    b.pausedRead = undefined;
  };
  await b.sync();
  await syncAll([b, a]);
  assert.equal(b.store.get("x:k"), "B, renamed meanwhile");
  assert.equal(a.store.get("x:k"), "B, renamed meanwhile");
});

class Choosy extends Device {
  chosen = new Set<string>();
  override adapters(): Adapter[] {
    const [items, ...rest] = super.adapters();
    return [
      {
        ...items!,
        extract: () => ({ values: new Map(this.store), republish: (k) => this.chosen.has(k), published: (keys) => keys.forEach((k) => this.chosen.delete(k)) }),
      },
      ...rest,
    ];
  }
}

test("an item chosen again with the same value while its deletion is pulled is kept", async () => {
  const folder = new Folder();
  const a = new Choosy("devA", folder);
  const b = new Choosy("devB", folder);
  a.store.set("x:pin", "same");
  await syncAll([a, b]);
  folder.now += 10;
  a.store.delete("x:pin");
  await a.sync();
  folder.now += 10;
  b.onRead = () => {
    b.store.set("x:pin", "same");
    b.chosen.add("x:pin");
    b.onRead = undefined;
  };
  await b.sync();
  await syncAll([b, a]);
  assert.equal(b.store.get("x:pin"), "same", "B keeps what it chose");
  assert.equal(a.store.get("x:pin"), "same", "and A takes it back");
});

test("an apply held while quitting leaves what it pulled unapplied, and a joining scope still joining", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.settings.set("set:theme", "dark");
  a.store.set("x:1", "one");
  await syncAll([a]);
  let quitting = true;
  const b = new Device("b", folder, { holdApply: () => quitting });
  b.state.awaitRemote = true;
  b.settings.set("set:theme", "light");
  await b.sync();
  assert.equal(b.store.size, 0, "nothing is applied");
  assert.deepEqual([...b.state.unapplied].sort(), ["set:theme", "x:1"]);
  assert.equal(b.state.joined, false, "and the scope hasn't joined, so its defaults still wait");
  quitting = false;
  await b.sync();
  assert.equal(b.store.get("x:1"), "one");
  assert.equal(b.settings.get("set:theme"), "dark", "joining takes the synced setting");
  assert.equal(b.state.joined, true);
});

test("steady browsing doesn't rewrite a large snapshot every few minutes", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder, { pruneGrace: 60 * 60_000 });
  for (let i = 0; i < 3000; i++) a.store.set(`x:h${i}`, { t: `https://example.com/page/${i}`, n: 3, vt: Array.from({ length: 20 }, (_, j) => 1_790_000_000_000 + i * 1000 + j) });
  await a.sync();
  let snapshots = 0;
  let snapshotBytes = 0;
  let logBytes = 0;
  const seen = new Set(folder.scope("s").keys());
  for (let step = 0; step < 8 * 240; step++) {
    folder.now += 15_000;
    a.store.set(`x:h${step % 3000}`, { t: `https://example.com/page/${step % 3000}`, n: 4 + step, vt: [folder.now] });
    await a.sync();
    for (const [id, e] of folder.scope("s")) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (e.payload.includes('"kind":"snapshot"')) {
        snapshots++;
        snapshotBytes += e.payload.length;
      } else logBytes += e.payload.length;
    }
  }
  assert.ok(snapshots <= 6, `${snapshots} snapshots, ${snapshotBytes} bytes for ${logBytes} bytes of changes`);
  assert.ok(folder.fileCount() <= 600, `${folder.fileCount()} files left`);
});

test("an idle Mac writes nothing and still clears the files its snapshot covers", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder, { pruneGrace: 60 * 60_000 });
  let compactions = 0;
  for (let step = 0; step < 60; step++) {
    folder.now += 15_000;
    a.store.set(`x:${step}`, step);
    if ((await a.sync()).compacted) compactions++;
  }
  folder.now += 10 * 60_000;
  if ((await a.sync()).compacted) compactions++;
  assert.equal(compactions, 1);
  const written = folder.counter;
  for (let step = 0; step < 24 * 60; step++) {
    folder.now += 60_000;
    assert.equal((await a.sync()).compacted, false);
  }
  assert.equal(folder.counter, written);
  assert.equal(folder.fileCount(), 20);
});

function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    if (++arrived === count) release();
    await all;
  };
}

async function concurrently(devices: Device[]) {
  const gate = barrier(devices.length);
  for (const d of devices) d.afterRead = gate;
  const results = await Promise.all(devices.map((d) => d.sync()));
  for (const d of devices) delete d.afterRead;
  return results;
}

test("Macs compacting and pruning at the same moment never empty the folder, with equal snapshot vectors", async () => {
  const folder = new Folder();
  const hour = 60 * 60_000;
  const opts: ScopeOptions = { pruneGrace: hour };
  const [a, b] = ["devA", "devB"].map((id) => new Device(id, folder, opts)) as [Device, Device];
  const snapshots = () => [...folder.scope("s").values()].filter((e) => e.payload.includes('"kind":"snapshot"')).map((e) => JSON.parse(e.payload) as { device: string; vv: Record<string, number> });
  let n = 0;
  for (let round = 0; round < 2; round++) {
    opts.compactAfterFiles = 1000;
    for (let i = 0; i < 41; i++) {
      folder.now += 1000;
      for (const d of [a, b]) {
        d.store.set(`x:${d.id}-${n++}`, n);
        await d.sync();
      }
    }
    delete opts.compactAfterFiles;
    folder.now += 11 * 60_000;
    assert.deepEqual((await concurrently([a, b])).map((r) => r.compacted), [true, true], `round ${round}`);
    const fresh = snapshots().filter((f) => f.vv.devA === 41 * (round + 1));
    assert.equal(fresh.length, 2, `round ${round}`);
    assert.deepEqual(fresh[0]!.vv, fresh[1]!.vv);
    folder.now += hour + 60_000;
    assert.deepEqual((await concurrently([a, b])).map((r) => r.compacted), [false, false], `round ${round}`);
    assert.ok(snapshots().length >= 2, `round ${round}: ${snapshots().length} snapshots left`);
    for (let i = 0; i < 3; i++) await concurrently([a, b]);
    const c = new Device(`devC${round}`, folder, opts);
    await c.sync();
    assert.equal(c.store.size, n, `round ${round}`);
    assert.deepEqual(snapshot(c), snapshot(a));
    assert.deepEqual(snapshot(c), snapshot(b));
  }
});

test("a cycle whose apply is held keeps 200,000 pulled keys for later, where a call with one argument per key would overflow", async () => {
  const count = 200_000;
  const ops = Array.from({ length: count }, (_, i) => ({ k: `h:${i}`, h: "000000000001000.0000.devB", v: i }));
  const remote: LogFile = { v: 1, kind: "log", device: "devB", seq: 1, at: 1000, ops };
  const transport: Transport = {
    write: async () => "own",
    read: async () => ({ files: [{ id: "remote", payload: JSON.stringify(remote) }], pending: [], damaged: [], present: ["remote"] }),
    remove: async () => {},
  };
  const refusing: Adapter = { prefix: "h:", extract: () => null, apply: () => false };
  const state = emptyScope();
  const result = await syncScope({ scope: "s", state, transport, adapters: [refusing], clock: new Clock("devA"), device: "devA", now: () => 2000 });
  assert.equal(result.changed, count);
  assert.equal(state.unapplied.length, count);
  assert.equal(state.unapplied[count - 1], `h:${count - 1}`);
});

for (const arrival of ["in order", "shuffled"]) {
  test(`20,000 logs read behind a missing first one, ${arrival}, are tracked and then closed up without a scan per log`, async () => {
    const count = 20_000;
    const log = (seq: number) => ({ id: `l${seq}`, payload: JSON.stringify({ v: 1, kind: "log", device: "devB", seq, at: 1000, ops: [] } satisfies LogFile) });
    const logs = Array.from({ length: count }, (_, i) => log(i + 2));
    let seed = 7;
    if (arrival === "shuffled") {
      for (let i = logs.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [logs[i], logs[j]] = [logs[j]!, logs[i]!];
      }
    }
    let files = logs;
    const transport: Transport = {
      write: async () => "own",
      read: async (_scope, known) => {
        const seen = new Set(known);
        return { files: files.filter((f) => !seen.has(f.id)), pending: [], damaged: [], present: files.map((f) => f.id) };
      },
      remove: async () => {},
    };
    const state = emptyScope();
    const run = () => syncScope({ scope: "s", state, transport, adapters: [], clock: new Clock("devA"), device: "devA", now: () => 2000 });
    const { includes, sort } = Array.prototype;
    let scanned = 0;
    Array.prototype.includes = function (this: unknown[], ...args: [unknown, number?]) {
      scanned += this.length;
      return includes.apply(this, args);
    };
    Array.prototype.sort = function <T>(this: T[], compare?: (a: T, b: T) => number) {
      scanned += this.length;
      return sort.call(this, compare) as T[];
    };
    try {
      await run();
      assert.equal(state.vv.devB ?? 0, 0);
      assert.equal(state.extra.devB!.length, count);
      files = [log(1), ...logs];
      await run();
    } finally {
      Array.prototype.includes = includes;
      Array.prototype.sort = sort;
    }
    assert.equal(state.vv.devB, count + 1);
    assert.equal(state.extra.devB, undefined);
    assert.ok(scanned < 20 * count, `${scanned} list entries scanned`);
  });
}

test("a joining scope stays joining while a file from another device is still downloading, so its own choices don't write over what that file holds", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  a.settings.set("set:theme", "dark");
  await a.sync();
  const later = [...folder.scope("s").keys()].at(-1)!;
  const b = new Device("b", folder);
  b.state.awaitRemote = true;
  b.settings.set("set:theme", "light");
  folder.scope("s").get(later)!.hiddenFrom.add("b");
  await b.sync();
  assert.equal(b.store.get("x:1"), "one", "what has arrived is applied");
  assert.equal(b.state.joined, false, "the scope waits for the file still downloading");
  assert.equal(b.state.pending, 1);
  folder.scope("s").get(later)!.hiddenFrom.delete("b");
  await b.sync();
  assert.equal(b.state.joined, true);
  assert.equal(b.settings.get("set:theme"), "dark", "joining takes the setting from the file that came in late");
  await a.sync();
  assert.equal(a.settings.get("set:theme"), "dark", "and the first device's setting doesn't drift to the joining one's");
});

test("a joining scope whose file never finishes downloading joins once that file stops holding anything back", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  a.settings.set("set:theme", "dark");
  await a.sync();
  const later = [...folder.scope("s").keys()].at(-1)!;
  folder.scope("s").get(later)!.hiddenFrom.add("b");
  const b = new Device("b", folder);
  b.state.awaitRemote = true;
  await b.sync();
  assert.equal(b.state.joined, false);
  folder.now += 86_400_001;
  await b.sync();
  assert.equal(b.state.joined, true, "a download that never lands stops holding the join back after a day");
});

class SessionDevice extends Device {
  override adapters(): Adapter[] {
    return super.adapters().map((adapter) => (adapter.prefix === "x:" ? { ...adapter, sessionBacked: true } : adapter));
  }
}

test("a rebase after the local data went back in time publishes no deletions, takes what's synced and still sends what's only here", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  a.store.set("x:2", "two");
  a.store.set("x:3", "three");
  a.store.set("x:5", "five");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  assert.deepEqual([...b.store.keys()].sort(), ["x:1", "x:2", "x:3", "x:5"]);
  a.store.delete("x:5");
  a.store.set("x:1", "one, renamed");
  await a.sync();

  b.store = new Map<string, unknown>([["x:1", "one"], ["x:5", "five"], ["x:4", "four"]]);
  startRebase(b.state);
  await b.sync();
  assert.deepEqual(b.state.rebase, ["x:"], "the rebase ends for the adapter once it applied");
  assert.deepEqual(Object.fromEntries([...b.store].sort()), { "x:1": "one, renamed", "x:2": "two", "x:3": "three", "x:4": "four" }, "the synced data comes back, a deletion made elsewhere still applies, and what's only here stays");

  await a.sync();
  assert.deepEqual(Object.fromEntries([...a.store].sort()), { "x:1": "one, renamed", "x:2": "two", "x:3": "three", "x:4": "four" }, "the other device loses nothing and gets the new item");

  b.store.delete("x:2");
  await b.sync();
  await a.sync();
  assert.equal(a.store.has("x:2"), false, "after the rebase a deletion made here goes out as before");
});

test("without a rebase the same stale local data would publish deletions, which is what the rebase prevents", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  a.store.set("x:2", "two");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  b.store = new Map();
  await b.sync();
  await a.sync();
  assert.equal(a.store.size, 0, "a three-way sync reads the missing items as deleted here");
});

test("a rebase leaves adapters that don't read the session alone, and stays on for one that couldn't apply yet", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.settings.set("set:theme", "dark");
  a.store.set("x:1", "one");
  await a.sync();
  let ready = false;
  const b = new Device("b", folder);
  const own = b.adapters();
  b.adapters = () => [
    { ...own[0]!, sessionBacked: true, apply: (visible, changed, base, records) => (ready ? own[0]!.apply(visible, changed, base, records) : false) },
    own[1]!,
  ];
  await b.sync();
  b.store.set("x:9", "nine");
  startRebase(b.state);
  await b.sync();
  assert.deepEqual(b.state.rebase, [], "the session-backed adapter couldn't apply, so the rebase waits for it");
  ready = true;
  await b.sync();
  assert.deepEqual(b.state.rebase, ["x:"]);
  await a.sync();
  assert.equal(a.store.get("x:9"), "nine");
});

test("a joining scope whose only file from another device never downloads still joins after a day, instead of waiting for good", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  for (const entry of folder.scope("s").values()) entry.hiddenFrom.add("b");
  const b = new Device("b", folder);
  b.state.awaitRemote = true;
  b.settings.set("set:theme", "light");
  await b.sync();
  assert.equal(b.state.joined, false);
  folder.now += 86_400_000 - 1;
  await b.sync();
  assert.equal(b.state.joined, false, "within a day it keeps waiting");
  folder.now += 3 * 86_400_000;
  await b.sync();
  assert.equal(b.state.joined, true, "past a day the scope joins, though no file from another device was ever read");
  assert.equal(b.state.awaitRemote, undefined);
  assert.equal(b.state.awaitSince, undefined);
});

test("a joining scope's wait survives a relaunch and a clock set back, and still ends a day after it began", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  for (const entry of folder.scope("s").values()) entry.hiddenFrom.add("b");
  const b = new Device("b", folder);
  b.state.awaitRemote = true;
  folder.now = 10 * 86_400_000;
  await b.sync();
  b.relaunch();
  folder.now = 5 * 86_400_000;
  await b.sync();
  assert.equal(b.state.joined, false, "a clock set back restarts the wait from now instead of ending it");
  folder.now += 86_400_001;
  await b.sync();
  assert.equal(b.state.joined, true);
});

test("a cycle reports how many session-backed base writes it made, and only those", async () => {
  const folder = new Folder();
  const a = new SessionDevice("a", folder);
  a.store.set("x:1", "one");
  a.settings.set("set:theme", "dark");
  const first = await a.sync();
  assert.equal(first.sessionBaseWrites, 1, "x: is session-backed here, set: isn't");
  const idle = await a.sync();
  assert.equal(idle.sessionBaseWrites, 0, "a cycle that changes nothing reports none");
  const b = new Device("b", folder);
  b.store.set("x:2", "two");
  await b.sync();
  const pulled = await a.sync();
  assert.equal(pulled.sessionBaseWrites, 1, "applying a record from another device counts too");
});

class TwoSessionDevice extends Device {
  withSettings = true;
  override adapters(): Adapter[] {
    return super.adapters().filter((adapter) => this.withSettings || adapter.prefix !== "set:").map((adapter) => ({ ...adapter, sessionBacked: true, adoptRemoteOnJoin: false }));
  }
}

test("a rebase keeps a local value its adapter says is newer than the synced record", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  a.store.set("x:2", "two");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  b.store = new Map<string, unknown>([["x:1", "one, edited here and not sent yet"]]);
  const own = b.adapters();
  b.adapters = () => own.map((adapter) => (adapter.prefix === "x:" ? { ...adapter, extract: async (...args) => ({ ...(await adapter.extract(...args))!, keepLocal: (key: string) => key === "x:1" }) } : adapter));
  startRebase(b.state);
  await b.sync();
  await a.sync();
  assert.equal(a.store.get("x:1"), "one, edited here and not sent yet", "the edit the adapter vouches for goes out");
  assert.equal(a.store.get("x:2"), "two", "and nothing is deleted");
});

test("a rebase stays open for a session-backed adapter that isn't running yet, so it can't publish stale values when it comes back", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.settings.set("set:theme", "light");
  await a.sync();
  const b = new TwoSessionDevice("b", folder);
  await b.sync();
  a.settings.set("set:theme", "dark");
  await a.sync();
  await b.sync();
  assert.equal(b.settings.get("set:theme"), "dark");
  b.settings.set("set:theme", "light");
  b.withSettings = false;
  startRebase(b.state);
  await b.sync();
  assert.deepEqual(b.state.rebase, ["x:"], "the adapter that ran finished its rebase; settings still has to");
  b.withSettings = true;
  await b.sync();
  await a.sync();
  assert.equal(a.settings.get("set:theme"), "dark", "the stale setting from the older session isn't published over the newer one");
  assert.equal(b.settings.get("set:theme"), "dark", "and the device takes the synced value");
});

test("a rebase publishes nothing and doesn't finish while a file from another device is still downloading", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  a.store.set("x:2", "two, newer");
  await a.sync();
  const later = [...folder.scope("s").keys()].at(-1)!;
  folder.scope("s").get(later)!.hiddenFrom.add("b");
  b.store = new Map<string, unknown>([["x:1", "one"], ["x:2", "two, from an older session"]]);
  startRebase(b.state);
  await b.sync();
  await b.sync();
  assert.deepEqual(b.state.rebase, [], "the rebase waits for the file still downloading");
  await a.sync();
  assert.equal(a.store.get("x:2"), "two, newer", "the older session's value isn't published while the newer record is on its way");
  folder.scope("s").get(later)!.hiddenFrom.delete("b");
  await b.sync();
  assert.deepEqual(b.state.rebase, ["x:"]);
  assert.equal(b.store.get("x:2"), "two, newer");
  await a.sync();
  assert.equal(a.store.get("x:2"), "two, newer");
});

test("while a download holds a rebase back, a pulled change doesn't overwrite a local value the adapter keeps, which goes out once the hold clears", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  b.store.set("x:1", "mine, newer");
  const own = b.adapters();
  b.adapters = () => own.map((adapter) => (adapter.prefix === "x:" ? { ...adapter, extract: async (...args) => ({ ...(await adapter.extract(...args))!, keepLocal: (key: string) => key === "x:1" }) } : adapter));
  startRebase(b.state);
  a.store.set("x:1", "one, edited on a");
  await a.sync();
  a.store.set("x:2", "two");
  await a.sync();
  const later = [...folder.scope("s").keys()].at(-1)!;
  folder.scope("s").get(later)!.hiddenFrom.add("b");
  await b.sync();
  assert.equal(b.store.get("x:1"), "mine, newer", "the pulled change waits with the rebase");
  folder.scope("s").get(later)!.hiddenFrom.delete("b");
  await b.sync();
  await a.sync();
  assert.equal(a.store.get("x:1"), "mine, newer", "once nothing is held, the kept value goes out");
  assert.equal(b.store.get("x:2"), "two");
});

test("a rebase publishes a value the adapter keeps even when it equals the base, instead of applying the older record", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  a.store.set("x:1", "two");
  await a.sync();
  const own = b.adapters();
  const kept = (key: string) => key === "x:1";
  b.adapters = () => own.map((adapter) => (adapter.prefix === "x:" ? { ...adapter, extract: async (...args) => ({ ...(await adapter.extract(...args))!, keepLocal: kept }) } : adapter));
  startRebase(b.state);
  await b.sync();
  assert.equal(b.store.get("x:1"), "one", "the value chosen here, the same as the base, stays");
  await a.sync();
  assert.equal(a.store.get("x:1"), "one", "and goes out over the older record");
});

test("outside a rebase a value the adapter would keep isn't republished just for matching the base, so a skewed clock can't make it win", async () => {
  const folder = new Folder();
  const a = new Device("a", folder);
  a.store.set("x:1", "one");
  await a.sync();
  const b = new SessionDevice("b", folder);
  await b.sync();
  a.store.set("x:1", "two");
  await a.sync();
  const own = b.adapters();
  b.adapters = () => own.map((adapter) => (adapter.prefix === "x:" ? { ...adapter, extract: async (...args) => ({ ...(await adapter.extract(...args))!, keepLocal: (key: string) => key === "x:1" }) } : adapter));
  await b.sync();
  assert.equal(b.store.get("x:1"), "two", "the newer record applies as usual");
  await a.sync();
  assert.equal(a.store.get("x:1"), "two");
});
