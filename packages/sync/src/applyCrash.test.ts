import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock } from "./hlc.ts";
import { restoreJournal, syncScope } from "./scope.ts";
import { emptyScope, type Adapter, type ApplyBatch, type Listing, type LogFile, type ScopeState, type Transport } from "./scopeState.ts";

const SAVE_MS = 30_000;

class Folder {
  files = new Map<string, string>();
  pendingFor = new Map<string, Set<string>>();
  counter = 0;
  now = 1_000_000;
  transport(device = ""): Transport {
    return {
      write: async (_scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, payload);
        return id;
      },
      read: async (_scope, known): Promise<Listing> => {
        const listing: Listing = { files: [], pending: [], damaged: [], present: [] };
        for (const [id, payload] of this.files) {
          listing.present.push(id);
          if (known.includes(id)) continue;
          if (this.pendingFor.get(device)?.has(id)) listing.pending.push(id);
          else listing.files.push({ id, payload });
        }
        return listing;
      },
      remove: async (_scope, ids) => {
        for (const id of ids) this.files.delete(id);
      },
    };
  }
}

type Saved = { kind: "state"; json: string; clock: string | null } | { kind: "batch"; json: string } | { kind: "journal"; json: string };
type Mode = { replaces?: boolean; throttled?: boolean; failsAfter?: string; ignores?: (key: string) => boolean; slowApplyMs?: number; quitting?: boolean; onePerCycle?: boolean; republishes?: string; journalFails?: boolean; killedBeforeCycleRecord?: boolean; landsBeforeFailing?: boolean; whole?: boolean; writesThenFails?: boolean; retireFails?: boolean };

class Mac {
  memory = new Map<string, unknown>();
  disk = new Map<string, unknown>();
  state: ScopeState = emptyScope();
  clock: Clock;
  steady = 0;
  launches = 0;
  launch: string;
  writeAhead: boolean;
  mode: Mode = {};
  duringWriteAhead?: () => void;
  saved: Saved[] = [];
  applies = 0;
  extracts = 0;
  readonly id: string;
  readonly folder: Folder;
  constructor(id: string, folder: Folder, writeAhead = true) {
    this.id = id;
    this.folder = folder;
    this.writeAhead = writeAhead;
    this.clock = new Clock(id, null, () => folder.now);
    this.launch = `${id}-0`;
  }
  tick(ms: number) {
    this.folder.now += ms;
    this.steady += ms;
  }
  adapter(): Adapter {
    return {
      prefix: "b:",
      savesWhole: !!this.mode.whole,
      extract: () => {
        if (this.mode.throttled || (this.mode.onePerCycle && this.extracts++ > 0)) return null;
        const ignores = this.mode.ignores;
        const republishes = this.mode.republishes;
        return { values: new Map([...this.memory].filter(([key]) => !ignores?.(key))), ignore: ignores, republish: republishes ? (key: string) => key === republishes : undefined };
      },
      apply: (visible, changed, _base, records) => {
        this.applies++;
        if (this.mode.slowApplyMs) this.tick(this.mode.slowApplyMs);
        if (this.mode.replaces) {
          this.memory = new Map([...visible].filter(([key]) => key.startsWith("b:")));
          return;
        }
        for (const key of [...changed].sort()) {
          if (key === this.mode.failsAfter) return false;
          visible.has(key) ? this.memory.set(key, visible.get(key)) : this.memory.delete(key);
          if (this.mode.landsBeforeFailing) records.landed(key);
        }
        if (this.mode.writesThenFails) return false;
      },
    };
  }
  chromeSaves() {
    this.disk = new Map(this.memory);
  }
  async sync() {
    const persistApplying = this.writeAhead
      ? async (batch: ApplyBatch) => {
          if (this.mode.journalFails || (this.mode.retireFails && !Object.keys(batch.k).length)) throw new Error("disk full");
          this.saved.push({ kind: "batch", json: JSON.stringify(batch) });
          await new Promise((resolve) => setImmediate(resolve));
          this.duringWriteAhead?.();
          delete this.duringWriteAhead;
        }
      : undefined;
    this.extracts = 0;
    const result = await syncScope({
      scope: "s",
      state: this.state,
      transport: this.folder.transport(this.id),
      adapters: [this.adapter()],
      clock: this.clock,
      device: this.id,
      now: () => this.folder.now,
      options: { pruneGrace: 0, persist: async (files) => void this.saved.push({ kind: "journal", json: JSON.stringify(files) }), persistApplying, launch: this.launch, nativeSaveMs: SAVE_MS, monotonic: () => this.steady, holdApply: () => !!this.mode.quitting },
    });
    if (!this.mode.killedBeforeCycleRecord) this.saved.push({ kind: "state", json: JSON.stringify(this.state), clock: this.clock.last });
    return result;
  }
  killed() {
    this.memory = new Map(this.disk);
    const last = this.saved.map((s) => s.kind).lastIndexOf("state");
    const state = last >= 0 ? (this.saved[last] as Extract<Saved, { kind: "state" }>) : null;
    this.state = state ? (JSON.parse(state.json) as ScopeState) : emptyScope();
    const journal: LogFile[] = [];
    for (const later of this.saved.slice(last + 1)) {
      if (later.kind === "journal") journal.push(...(JSON.parse(later.json) as LogFile[]));
      if (later.kind !== "batch") continue;
      const batch = JSON.parse(later.json) as ApplyBatch;
      const others = (this.state.applying ?? []).filter((b) => b.id !== batch.id);
      this.state.applying = Object.keys(batch.k).length ? [...others, batch] : others;
    }
    this.clock = new Clock(this.id, state?.clock ?? null, () => this.folder.now);
    restoreJournal(this.state, journal, this.clock);
    this.mode = {};
    this.launch = `${this.id}-${++this.launches}`;
    this.steady = 0;
  }
}

const settle = async (macs: Mac[], rounds = 3) => {
  for (let i = 0; i < rounds; i++) {
    for (const mac of macs) {
      mac.tick(1_000);
      await mac.sync();
    }
  }
};

async function pairWith(bookmarks: Record<string, string>, writeAhead = true) {
  const folder = new Folder();
  const a = new Mac("macA", folder, writeAhead);
  const b = new Mac("macB", folder, writeAhead);
  for (const [key, title] of Object.entries(bookmarks)) a.memory.set(key, title);
  await settle([a, b]);
  a.chromeSaves();
  b.chromeSaves();
  a.tick(SAVE_MS + 1);
  b.tick(SAVE_MS + 1);
  await settle([a, b]);
  return { folder, a, b };
}

async function remoteChange(a: Mac, b: Mac, edit: () => void) {
  edit();
  a.tick(1_000);
  await a.sync();
  b.tick(1_000);
  return b.sync();
}

const view = (mac: Mac) => Object.fromEntries([...mac.memory].sort(([x], [y]) => x.localeCompare(y)));

test("a bookmark deleted on another Mac stays deleted after this Mac is killed before Chrome saved the rename it applied", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1", "b:t2": "T2" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  assert.equal(b.memory.get("b:t1"), "T1 renamed");
  b.killed();
  assert.equal(b.memory.get("b:t1"), "T1");
  a.memory.delete("b:t1");
  a.tick(1_000);
  await a.sync();
  b.tick(60_000);
  await settle([b, a], 4);
  assert.deepEqual(view(a), { "b:t2": "T2" });
  assert.deepEqual(view(b), { "b:t2": "T2" });
});

test("a bookmark added on another Mac isn't deleted everywhere when this Mac is killed before Chrome saved it", async () => {
  const { a, b } = await pairWith({ "b:t2": "T2" });
  await remoteChange(a, b, () => a.memory.set("b:new", "New"));
  b.killed();
  assert.equal(b.memory.has("b:new"), false);
  b.tick(60_000);
  const { reapplied, published } = await b.sync();
  assert.equal(published, 0);
  assert.equal(reapplied, 1);
  await settle([a, b], 3);
  assert.deepEqual(view(a), { "b:new": "New", "b:t2": "T2" });
  assert.deepEqual(view(b), { "b:new": "New", "b:t2": "T2" });
});

test("without the write-ahead journal the same crash republishes the stale rename", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" }, false);
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  a.memory.delete("b:t1");
  a.tick(1_000);
  await a.sync();
  b.tick(60_000);
  await settle([b, a], 4);
  assert.equal(a.memory.get("b:t1"), "T1");
});

test("an edit made offline after the crash still wins over the recovery", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  b.tick(60_000);
  b.memory.set("b:t1", "B's own title");
  await settle([b, a], 3);
  assert.equal(a.memory.get("b:t1"), "B's own title");
  assert.equal(b.memory.get("b:t1"), "B's own title");
});

test("a second kill during recovery, before Chrome saved the re-apply, still recovers", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1", "b:t2": "T2" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  b.tick(60_000);
  await b.sync();
  assert.equal(b.memory.get("b:t1"), "T1 renamed");
  b.killed();
  assert.equal(b.memory.get("b:t1"), "T1");
  a.memory.delete("b:t2");
  a.tick(1_000);
  await a.sync();
  b.tick(60_000);
  await settle([b, a], 4);
  assert.deepEqual(view(a), { "b:t1": "T1 renamed" });
  assert.deepEqual(view(b), { "b:t1": "T1 renamed" });
});

test("a Mac killed after Chrome saved takes the applied value and publishes nothing", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.chromeSaves();
  b.killed();
  b.tick(60_000);
  const { published, reapplied } = await b.sync();
  assert.equal(published, 0);
  assert.equal(reapplied, 0);
  assert.equal(!!b.state.applying?.some((batch) => batch.l !== b.launch), false);
});

test("the batch clears only once Chrome's save window has passed after the apply finished, on the steady clock", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  b.mode.slowApplyMs = 40_000;
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  delete b.mode.slowApplyMs;
  assert.equal(b.state.applying?.length, 1);
  assert.ok(b.saved.some((s) => s.kind === "batch"));
  b.tick(1_000);
  await b.sync();
  assert.equal(b.state.applying?.length, 1, "a slow apply doesn't start its window before it ends");
  b.folder.now += 3_600_000;
  await b.sync();
  assert.equal(b.state.applying?.length, 1, "a wall clock jump doesn't end the window");
  b.steady += SAVE_MS;
  await b.sync();
  assert.equal(b.state.applying, undefined);
});

test("a local edit made while the write-ahead journal is being written isn't erased by an apply that replaces everything", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1", "b:t2": "T2" });
  b.mode.replaces = true;
  b.duringWriteAhead = () => b.memory.set("b:t2", "T2 edited on B");
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  assert.equal(b.memory.get("b:t2"), "T2 edited on B");
  await settle([a, b], 2);
  assert.deepEqual(view(a), { "b:t1": "T1 renamed", "b:t2": "T2 edited on B" });
  assert.deepEqual(view(b), view(a));
});

test("an apply that wrote a key and then failed keeps that value as a candidate when the next apply targets something else", async () => {
  const { a, b } = await pairWith({ "b:a": "A0", "b:z": "Z0" });
  b.mode.failsAfter = "b:z";
  await remoteChange(a, b, () => (a.memory.set("b:a", "A1"), a.memory.set("b:z", "Z1")));
  assert.equal(b.memory.get("b:a"), "A1");
  b.mode = { throttled: true };
  await remoteChange(a, b, () => a.memory.set("b:a", "A2"));
  assert.equal(b.memory.get("b:a"), "A2");
  b.disk = new Map([["b:a", "A1"], ["b:z", "Z0"]]);
  b.killed();
  b.mode = {};
  b.tick(60_000);
  await settle([b, a], 3);
  assert.deepEqual(view(a), { "b:a": "A2", "b:z": "Z1" });
  assert.deepEqual(view(b), view(a));
});

test("a stale apply another Mac reverted before the restart leaves no batch to swallow a later edit", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  b.killed();
  a.memory.set("b:t1", "A");
  a.tick(1_000);
  await a.sync();
  b.tick(60_000);
  await settle([b, a], 2);
  assert.equal(!!b.state.applying?.some((batch) => batch.l !== b.launch), false);
  b.memory.set("b:t1", "B");
  await settle([b, a], 2);
  assert.equal(a.memory.get("b:t1"), "B");
});

test("many applies inside one save window keep the value Chrome last saved", async () => {
  const { a, b } = await pairWith({ "b:t1": "v0" });
  for (let i = 1; i <= 12; i++) await remoteChange(a, b, () => a.memory.set("b:t1", `v${i}`));
  b.killed();
  assert.equal(b.memory.get("b:t1"), "v0");
  b.tick(60_000);
  const { published } = await b.sync();
  assert.equal(published, 0);
  await settle([b, a], 2);
  assert.equal(a.memory.get("b:t1"), "v12");
  assert.equal(b.memory.get("b:t1"), "v12");
});

test("a key ignored by the first pass after a restart keeps its batch until a later pass can judge it", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  a.memory.delete("b:t1");
  a.tick(1_000);
  await a.sync();
  b.mode = { ignores: (key) => key === "b:t1" };
  b.tick(60_000);
  await b.sync();
  assert.ok(b.state.applying?.some((batch) => batch.l !== b.launch && "b:t1" in batch.k));
  b.mode = {};
  await settle([b, a], 3);
  assert.deepEqual(view(a), {});
  assert.deepEqual(view(b), {});
});

test("a saved remote value with a newer local edit lost in the crash puts the edit back instead of keeping the older value", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  b.chromeSaves();
  b.memory.set("b:t1", "C");
  b.tick(1_000);
  await b.sync();
  b.killed();
  assert.equal(b.memory.get("b:t1"), "B");
  b.tick(60_000);
  await settle([b, a], 3);
  assert.equal(b.memory.get("b:t1"), "C");
  assert.equal(a.memory.get("b:t1"), "C");
});

test("the re-apply is counted only once it lands", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  b.mode = { failsAfter: "b:t1" };
  b.tick(60_000);
  assert.equal((await b.sync()).reapplied, 0);
  b.mode = {};
  b.tick(1_000);
  assert.equal((await b.sync()).reapplied, 1);
  b.tick(1_000);
  assert.equal((await b.sync()).reapplied, 0);
});

test("recovering 100,000 keys after a crash doesn't scan the unapplied list once per key", async () => {
  const { a, b } = await pairWith({});
  await remoteChange(a, b, () => {
    for (let i = 0; i < 100_000; i++) a.memory.set(`b:${i}`, i);
  });
  b.killed();
  b.state.unapplied = Array.from({ length: 100_000 }, (_, i) => `b:other${i}`);
  b.tick(60_000);
  const started = performance.now();
  const { published } = await b.sync();
  assert.equal(published, 0);
  assert.equal(b.memory.size, 100_000);
  assert.ok(performance.now() - started < 15_000, `took ${Math.round(performance.now() - started)} ms`);
});

test("an apply cancelled by a local edit made while its batch was written can't come back after a later edit and a crash", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  b.duringWriteAhead = () => b.memory.set("b:t1", "C");
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  assert.equal(b.memory.get("b:t1"), "C");
  assert.equal(b.state.applying, undefined, "the cancelled key leaves no batch behind");
  b.memory.set("b:t1", "B");
  b.chromeSaves();
  b.killed();
  b.tick(1_000);
  await settle([b, a], 3);
  assert.equal(b.memory.get("b:t1"), "B");
  assert.equal(a.memory.get("b:t1"), "B");
});

test("quitting while the batch is being written leaves the apply for the next launch", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  const before = b.applies;
  b.duringWriteAhead = () => (b.mode.quitting = true);
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  assert.equal(b.applies, before, "the native apply never ran");
  assert.equal(b.memory.get("b:t1"), "A");
  assert.ok(b.state.unapplied.includes("b:t1"));
});

test("a cancelled apply is retired on disk at once, so a crash before the cycle record can't bring it back over a later edit", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  b.duringWriteAhead = () => b.memory.set("b:t1", "C");
  b.mode.killedBeforeCycleRecord = true;
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  assert.equal(b.memory.get("b:t1"), "C");
  b.memory.set("b:t1", "B");
  b.chromeSaves();
  b.killed();
  await settle([b, a], 3);
  assert.equal(b.memory.get("b:t1"), "B");
  assert.equal(a.memory.get("b:t1"), "B");
});

test("an adapter that reads only once per cycle still recovers, from that one read", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  a.memory.delete("b:t1");
  a.tick(1_000);
  await a.sync();
  b.mode = { onePerCycle: true };
  b.tick(60_000);
  await b.sync();
  assert.equal(!!b.state.applying?.some((batch) => batch.l !== b.launch), false, "judged from the one read");
  b.mode = { onePerCycle: true };
  await settle([b, a], 3);
  assert.deepEqual(view(a), {});
  assert.deepEqual(view(b), {});
});

test("a key queued to be applied again isn't republished from the stale native value first", async () => {
  const { a, b } = await pairWith({ "b:t1": "T1" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "T1 renamed"));
  b.killed();
  b.mode = { republishes: "b:t1" };
  b.tick(60_000);
  const { published } = await b.sync();
  assert.equal(published, 0);
  assert.equal(b.memory.get("b:t1"), "T1 renamed");
  assert.equal(a.memory.get("b:t1"), "T1 renamed");
});

test("a write-ahead journal that can't be written fails the cycle and leaves a joining scope unjoined", async () => {
  const folder = new Folder();
  const a = new Mac("macA", folder);
  a.memory.set("b:t1", "T1");
  await a.sync();
  const b = new Mac("macB", folder);
  b.mode.journalFails = true;
  await assert.rejects(b.sync(), /couldn't journal/);
  assert.equal(b.state.joined, false);
  assert.equal(b.memory.has("b:t1"), false);
  assert.ok(b.state.unapplied.includes("b:t1"));
  b.mode = {};
  await b.sync();
  assert.equal(b.memory.get("b:t1"), "T1");
  assert.equal(b.state.joined, true);
});

test("a change Chrome saved whose record was lost in the crash isn't reverted while its sync file is still downloading", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "A" });
  b.mode.killedBeforeCycleRecord = true;
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  assert.equal(b.memory.get("b:t1"), "B");
  b.chromeSaves();
  b.killed();
  const newest = [...folder.files.keys()].at(-1)!;
  folder.pendingFor.set("macB", new Set([newest]));
  b.tick(60_000);
  const { published } = await b.sync();
  assert.equal(published, 0);
  assert.equal(b.memory.get("b:t1"), "B", "not put back to the checkpoint's older value");
  folder.pendingFor.clear();
  await settle([b, a], 2);
  assert.equal(b.memory.get("b:t1"), "B");
  assert.equal(a.memory.get("b:t1"), "B");
});

test("an offline edit back to the value a saved batch replaced is published, not taken for a crash leftover", async () => {
  const { a, b } = await pairWith({ "b:a": "A0", "b:b": "B0", "b:c": "C0" });
  await remoteChange(a, b, () => (a.memory.set("b:a", "A1"), a.memory.set("b:b", "B1"), a.memory.set("b:c", "C1")));
  b.chromeSaves();
  b.killed();
  b.mode = { whole: true };
  b.memory.set("b:a", "A0");
  b.tick(60_000);
  await settle([b, a], 3);
  assert.equal(b.memory.get("b:a"), "A0");
  assert.equal(a.memory.get("b:a"), "A0");
  assert.equal(a.memory.get("b:b"), "B1");
});

test("a recovered key that lands before a later key fails is counted once", async () => {
  const { a, b } = await pairWith({ "b:a": "A0", "b:z": "Z0" });
  await remoteChange(a, b, () => (a.memory.set("b:a", "A1"), a.memory.set("b:z", "Z1")));
  b.killed();
  b.mode = { failsAfter: "b:z", landsBeforeFailing: true };
  b.tick(60_000);
  const first = await b.sync();
  b.mode = {};
  b.tick(1_000);
  const second = await b.sync();
  assert.equal(first.reapplied + second.reapplied, 2);
});

test("a store that saves key by key keeps a deletion it saved from a batch whose additions it lost, and a newer visit elsewhere survives", async () => {
  const { a, b } = await pairWith({ "b:x": "visited" });
  await remoteChange(a, b, () => (a.memory.delete("b:x"), a.memory.set("b:y", "Y"), a.memory.set("b:z", "Z")));
  b.disk = new Map();
  b.killed();
  a.memory.set("b:x", "visited again");
  a.tick(1_000);
  await a.sync();
  b.tick(60_000);
  const { published } = await b.sync();
  assert.equal(published, 0, "no fresh tombstone for the deletion Chrome already saved");
  await settle([b, a], 3);
  assert.deepEqual(view(a), { "b:x": "visited again", "b:y": "Y", "b:z": "Z" });
  assert.deepEqual(view(b), view(a));
});

test("an apply that wrote the store but reported failure isn't published as this Mac's edit over a newer deletion", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  b.mode = { writesThenFails: true };
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  assert.equal(b.memory.get("b:t1"), "B");
  b.mode = {};
  a.memory.delete("b:t1");
  a.tick(1_000);
  await a.sync();
  b.tick(1_000);
  const { published } = await b.sync();
  assert.equal(published, 0);
  await settle([a, b], 2);
  assert.deepEqual(view(a), {});
  assert.deepEqual(view(b), {});
});

test("a cancelled apply whose retirement can't be written stops the cycle, so the edit that cancelled it never outruns the batch on disk", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  b.duringWriteAhead = () => b.memory.set("b:t1", "C");
  b.mode = { retireFails: true, killedBeforeCycleRecord: true };
  await remoteChange(a, b, () => a.memory.set("b:t1", "B")).catch(() => {});
  b.memory.set("b:t1", "B");
  b.chromeSaves();
  b.killed();
  await settle([b, a], 3);
  assert.equal(b.memory.get("b:t1"), "B");
  assert.equal(a.memory.get("b:t1"), "B");
});

test("a recovered key the other Mac already put back to what Chrome holds isn't counted as applied again", async () => {
  const { a, b } = await pairWith({ "b:t1": "A" });
  await remoteChange(a, b, () => a.memory.set("b:t1", "B"));
  b.killed();
  a.memory.set("b:t1", "A");
  a.tick(1_000);
  await a.sync();
  b.tick(60_000);
  const { reapplied } = await b.sync();
  assert.equal(reapplied, 0);
  assert.equal(b.memory.get("b:t1"), "A");
});

test("a batch cut short before its cycle record was saved still counts as possibly partial, so a key it never reached isn't sent as an edit", async () => {
  const { a, b } = await pairWith({ "b:a": "A0", "b:b": "B0", "b:c": "C0", "b:z": "Z0" });
  b.mode = { failsAfter: "b:z", killedBeforeCycleRecord: true };
  await remoteChange(a, b, () => ["a", "b", "c", "z"].forEach((k) => a.memory.set(`b:${k}`, `${k.toUpperCase()}1`)));
  assert.equal(b.memory.get("b:z"), "Z0");
  b.chromeSaves();
  b.killed();
  b.mode = { whole: true };
  b.tick(60_000);
  const { published } = await b.sync();
  assert.equal(published, 0);
  await settle([b, a], 2);
  assert.equal(b.memory.get("b:z"), "Z1");
  assert.equal(a.memory.get("b:z"), "Z1");
});
