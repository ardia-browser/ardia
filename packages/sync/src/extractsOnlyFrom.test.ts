import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock } from "./hlc.ts";
import { syncScope } from "./scope.ts";
import { emptyScope, type Adapter, type Listing, type ScopeState, type Transport } from "./scopeState.ts";

class Folder {
  files = new Map<string, string>();
  counter = 0;
  transport(): Transport {
    return {
      write: async (_scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, payload);
        return id;
      },
      read: async (_scope, known): Promise<Listing> => {
        const present = [...this.files.keys()];
        return { files: present.filter((id) => !known.includes(id)).map((id) => ({ id, payload: this.files.get(id)! })), pending: [], damaged: [], present };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

class Device {
  state: ScopeState = emptyScope();
  clock: Clock;
  source = { items: new Map<string, string>() };
  notes = new Map<string, string>();
  extracts = 0;
  readonly id: string;
  readonly folder: Folder;
  constructor(id: string, folder: Folder) {
    this.id = id;
    this.folder = folder;
    this.clock = new Clock(id);
  }
  set(key: string, value: string) {
    this.source = { items: new Map(this.source.items).set(key, value) };
  }
  adapters(): Adapter[] {
    return [
      {
        prefix: "i:",
        extractsOnlyFrom: () => this.source,
        extract: () => {
          this.extracts++;
          return { values: new Map(this.source.items) };
        },
        apply: (visible, changed) => {
          const items = new Map(this.source.items);
          for (const key of changed) visible.has(key) ? items.set(key, visible.get(key) as string) : items.delete(key);
          this.source = { items };
        },
      },
      {
        prefix: "n:",
        extract: () => ({ values: new Map(this.notes) }),
        apply: (visible, changed) => {
          for (const key of changed) visible.has(key) ? this.notes.set(key, visible.get(key) as string) : this.notes.delete(key);
        },
      },
    ];
  }
  sync() {
    return syncScope({ scope: "s", state: this.state, transport: this.folder.transport(), adapters: this.adapters(), clock: this.clock, device: this.id });
  }
}

test("an adapter whose source and base entries are unchanged since its last publish isn't extracted again", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  a.set("i:1", "one");
  await a.sync();
  await a.sync();
  const after = a.extracts;
  for (let i = 0; i < 5; i++) assert.equal((await a.sync()).published, 0);
  assert.equal(a.extracts, after);
});

test("a new source object, a remote change to its base entries or a different join state extracts again", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  const b = new Device("B", folder);
  a.set("i:1", "one");
  await a.sync();
  await b.sync();
  await a.sync();
  let seen = a.extracts;
  a.set("i:2", "two");
  assert.equal((await a.sync()).published, 1);
  assert.equal(a.extracts, seen + 1);
  await b.sync();
  assert.deepEqual([...b.source.items].sort(), [["i:1", "one"], ["i:2", "two"]]);
  seen = b.extracts;
  await b.sync();
  await b.sync();
  assert.equal(b.extracts, seen + 1, "the apply rewrote B's base, so one cycle extracts again and the next doesn't");
  b.set("i:3", "three");
  await b.sync();
  seen = a.extracts;
  await a.sync();
  assert.equal(a.source.items.get("i:3"), "three");
  await a.sync();
  assert.ok(a.extracts > seen, "the remote change rewrote A's base, so A extracted again");
  const settled = a.extracts;
  await a.sync();
  assert.equal(a.extracts, settled);
  a.state.joined = !a.state.joined;
  await a.sync().catch(() => {});
  assert.equal(a.extracts, settled + 1);
});

test("writes under another adapter's prefix don't make this one extract again", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  a.set("i:1", "one");
  await a.sync();
  await a.sync();
  const seen = a.extracts;
  a.notes.set("n:1", "note");
  assert.equal((await a.sync()).published, 1);
  a.notes.set("n:2", "another");
  await a.sync();
  assert.equal(a.extracts, seen);
});

test("a skipped adapter still publishes what changed once its source changes, and deletions reach the other device", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  const b = new Device("B", folder);
  a.set("i:1", "one");
  a.set("i:2", "two");
  for (let i = 0; i < 2; i++) {
    await a.sync();
    await b.sync();
  }
  const items = new Map(a.source.items);
  items.delete("i:1");
  a.source = { items };
  await a.sync();
  await b.sync();
  assert.deepEqual([...b.source.items], [["i:2", "two"]]);
});
