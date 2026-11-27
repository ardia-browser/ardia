import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
let refuse = null;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    sealLocal: async (text) => {
      if (refuse?.(text)) throw new Error("disk full");
      return `sealed:${text}`;
    },
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
  },
};

const shell = await import("../../test-native/index.ts");
const { syncFiles } = await import("./syncFiles.ts");
const { emptyDoc } = await import("./syncDoc.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (_scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, payload);
        return id;
      },
      read: async (_scope, known) => ({ files: [...this.files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })), pending: [], damaged: [], present: [...this.files.keys()] }),
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

const adapterOver = (memory, hooks = {}) => ({
  prefix: "bm:",
  savesWhole: true,
  extract: () => ({ values: new Map(memory) }),
  apply: (visible, changed) => {
    for (const key of changed) visible.has(key) ? memory.set(key, visible.get(key)) : memory.delete(key);
    hooks.applied?.();
  },
});

class Remote {
  memory = new Map();
  state = emptyScope();
  clock = new Clock("devR");
  constructor(folder) {
    this.folder = folder;
  }
  sync() {
    return syncScope({ scope: "app", state: this.state, transport: this.folder.transport(), adapters: [adapterOver(this.memory)], clock: this.clock, device: "devR" });
  }
}

class Local {
  memory = new Map();
  disk = new Map();
  steady = 0;
  launch = 0;
  constructor(folder) {
    this.folder = folder;
  }
  async open() {
    this.doc = { ...emptyDoc(), enabled: true, deviceId: "devL", folder: "/sync", seqs: this.doc ? Object.fromEntries(Object.entries(this.doc.scopes).map(([k, s]) => [k, s.seq - (s.journal?.length ?? 0)])) : {}, clock: this.doc?.clock };
    this.files = syncFiles(() => this.doc);
    await this.files.loadState();
    this.doc.scopes.app ??= emptyScope();
    this.clock = new Clock("devL", this.doc.clock);
    this.launch++;
  }
  async sync({ duringWriteAhead } = {}) {
    this.steady += 1_000;
    const state = this.doc.scopes.app;
    const settled = this.files.watchScope("app", state, this.clock);
    const persistApplying = this.files.persistApplying("app");
    try {
      return await syncScope({
        scope: "app",
        state,
        transport: this.folder.transport(),
        adapters: [adapterOver(this.memory)],
        clock: this.clock,
        device: "devL",
        options: {
          persist: this.files.persistJournal("app"),
          persistApplying: async (batch) => {
            await persistApplying(batch);
            duringWriteAhead?.();
            duringWriteAhead = undefined;
          },
          launch: `devL-${this.launch}`,
          monotonic: () => this.steady,
        },
      });
    } finally {
      await settled();
      this.doc.clock = this.clock.last;
    }
  }
  chromeSaves() {
    this.disk = new Map(this.memory);
  }
  async killed() {
    this.memory = new Map(this.disk);
    await this.open();
  }
}

test("after a retirement that couldn't be written, the retry writes it before anything else goes out, so a later edit survives a crash", async () => {
  shell.docs.clear();
  const folder = new Folder();
  const remote = new Remote(folder);
  const local = new Local(folder);
  await local.open();
  remote.memory.set("bm:t1", "A");
  await remote.sync();
  await local.sync();
  local.chromeSaves();
  local.steady += 60_000;
  await local.sync();
  remote.memory.set("bm:t1", "B");
  await remote.sync();
  refuse = (text) => text.includes('"k":{}') || text.includes('"changes":') || text.includes('"covers":');
  await assert.rejects(local.sync({ duringWriteAhead: () => local.memory.set("bm:t1", "C") }));
  local.files.save();
  refuse = (text) => text.includes('"changes":') || text.includes('"covers":');
  await local.sync();
  refuse = null;
  local.memory.set("bm:t1", "B");
  local.chromeSaves();
  await local.killed();
  assert.equal(local.memory.get("bm:t1"), "B");
  local.steady += 60_000;
  await local.sync();
  await remote.sync();
  await local.sync();
  assert.equal(local.memory.get("bm:t1"), "B");
  assert.equal(remote.memory.get("bm:t1"), "B");
});
