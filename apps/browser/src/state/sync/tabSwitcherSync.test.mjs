import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { useEditClock } = await import("./editClock.ts");
const { settingsAdapter, settleSettingsFromSavedSync } = await import("./settingsAdapter.ts");
const { ctrlTabKeys } = await import("../commands/commandShortcuts.ts");

let syncTime = 0;
const nextSyncTime = () => (syncTime = Math.max(Date.now(), syncTime + 1));
const S = () => useBrowser.getState();
const STEP = { nextTab: ["\t", "control"], previousTab: ["\t", "control", "shift"] };
const SWITCHER = { "tabSwitcher:forward": ["\t", "control"], "tabSwitcher:backward": ["\t", "control", "shift"] };

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        const shown = [...this.files].filter(([, f]) => f.scope === scope);
        return { files: shown.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: shown.map(([id]) => id) };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

const publishing = (values) => ({ prefix: "set:", extract: () => ({ values: new Map(Object.entries(values()).map(([k, v]) => [`set:${k}`, { v }])), ignore: (key) => !(key.slice(4) in values()) }), apply: () => {} });

class Peer {
  constructor(id, folder, values) {
    this.id = id;
    this.folder = folder;
    this.values = values;
    this.scope = emptyScope();
    this.clock = new Clock(id, null, nextSyncTime);
  }
  set(values) {
    this.values = values;
  }
  async sync() {
    useEditClock(this.clock);
    await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: [publishing(() => this.values)], clock: this.clock, device: this.id });
  }
}

class Device {
  constructor(id, folder) {
    this.id = id;
    this.folder = folder;
    S().hydrate({});
    this.browser = S();
    this.scope = emptyScope();
    this.clock = new Clock(id, null, nextSyncTime);
  }
  with(fn) {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  async sync() {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: [settingsAdapter], clock: this.clock, device: this.id });
    } finally {
      this.browser = S();
    }
  }
  modes() {
    return this.with(() => ({ tabSwitcherOrder: S().settings.tabSwitcherOrder, tabSwitcherView: S().settings.tabSwitcherView }));
  }
  published() {
    return this.with(() => Object.fromEntries([...settingsAdapter.extract(() => undefined).values].filter(([key]) => key.startsWith("set:tabSwitcher")).map(([key, record]) => [key.slice(4), record.v])));
  }
}

test("a Compact list chosen here survives a legacy stepping record and a later Recent tabs record, and is never published as None", async () => {
  const run = async (together) => {
    const folder = new Folder();
    const device = new Device("B", folder);
    device.with(() => S().updateSettings({ tabSwitcherView: "compactList" }));
    const legacy = new Peer("old", folder, { shortcuts: STEP });
    const newer = new Peer("new", folder, { tabSwitcherOrder: "recent" });
    await legacy.sync();
    if (together) await newer.sync();
    await device.sync();
    if (!together) {
      await newer.sync();
      await device.sync();
    }
    return { modes: device.modes(), published: device.published() };
  };
  const separate = await run(false);
  assert.deepEqual(separate.modes, { tabSwitcherOrder: "recent", tabSwitcherView: "compactList" });
  assert.notEqual(separate.published.tabSwitcherView, "none");
  assert.equal(separate.published.tabSwitcherView, "compactList");
  assert.deepEqual(separate.modes, (await run(true)).modes, "the same as both records in one pull");
});

test("with no mode records, a legacy peer switching from stepping back to the recent tabs switcher ends the same in one pull or two", async () => {
  const run = async (separately) => {
    const folder = new Folder();
    const device = new Device("B", folder);
    const legacy = new Peer("old", folder, { shortcuts: STEP });
    await legacy.sync();
    if (separately) {
      await device.sync();
      assert.deepEqual(device.modes(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }, "stepping is inferred first");
    }
    legacy.set({ shortcuts: SWITCHER });
    await legacy.sync();
    await device.sync();
    return { modes: device.modes(), shortcuts: device.with(() => S().settings.shortcuts) };
  };
  const separate = await run(true);
  assert.deepEqual(separate.modes, { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" });
  assert.deepEqual(separate, await run(false));
});

test("a Compact list chosen here stays chosen and ⌃Tab still opens it after an older Mac syncs its stepping keys", async () => {
  const folder = new Folder();
  const device = new Device("B", folder);
  device.with(() => S().updateSettings({ tabSwitcherView: "compactList" }));
  const legacy = new Peer("old", folder, { shortcuts: STEP });
  await legacy.sync();
  await device.sync();
  await device.sync();
  assert.deepEqual(device.modes(), { tabSwitcherOrder: "recent", tabSwitcherView: "compactList" });
  assert.equal(device.with(() => ctrlTabKeys()), "switcher", "⌃Tab opens the switcher, not Next Tab");
  assert.deepEqual(device.with(() => S().settings.shortcuts), {});
});

test("two upgraded Macs that inferred stepping from an older Mac both keep it when one remaps an unrelated shortcut, and so does a Mac joining later", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  const b = new Device("B", folder);
  const legacy = new Peer("old", folder, { shortcuts: STEP });
  await legacy.sync();
  for (const device of [a, b]) await device.sync();
  for (const device of [a, b]) assert.deepEqual(device.modes(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }, device.id);
  a.with(() => S().updateSettings({ shortcuts: { ...S().settings.shortcuts, reload: ["r", "command", "shift"] } }));
  for (let i = 0; i < 2; i++) for (const device of [a, b]) await device.sync();
  for (const device of [a, b]) assert.deepEqual(device.modes(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }, `${device.id} after A remaps Reload`);
  assert.deepEqual(b.with(() => S().settings.shortcuts.reload), ["r", "command", "shift"], "B takes the remap");
  const c = new Device("C", folder);
  await c.sync();
  assert.deepEqual(c.modes(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }, "a Mac joining later agrees");
  for (const device of [a, b, c]) assert.equal(device.with(() => ctrlTabKeys()), "switcher", device.id);
});

test("shortcuts chosen here, a legacy stepping record and an idle sync leave a joining Mac stepping too", async () => {
  const folder = new Folder();
  const b = new Device("B", folder);
  await b.sync();
  b.with(() => S().updateSettings({ shortcuts: { reload: ["r", "command", "shift"] } }));
  await b.sync();
  const legacy = new Peer("old", folder, { shortcuts: STEP });
  await legacy.sync();
  await b.sync();
  await b.sync();
  assert.deepEqual(b.modes(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" });
  const c = new Device("C", folder);
  await c.sync();
  assert.deepEqual(c.modes(), b.modes(), "the joining Mac agrees after B's idle sync");
  assert.equal(c.with(() => ctrlTabKeys()), "switcher");
});

test("a Mac upgrading with legacy stepping keys takes the Compact list another Mac had already synced, instead of publishing None over it", async () => {
  const folder = new Folder();
  const newer = new Peer("new", folder, { tabSwitcherView: "compactList" });
  await newer.sync();
  const d = new Device("D", folder);
  await d.sync();
  d.with(() => S().hydrate({ settings: { shortcuts: { ...STEP } }, settingsMeta: { chosen: ["shortcuts"], inferred: [] } }));
  assert.equal(d.modes().tabSwitcherView, "none", "the launch upgrade infers stepping from the keys");
  d.with(() => settleSettingsFromSavedSync(d.scope, true));
  await d.sync();
  assert.equal(d.modes().tabSwitcherView, "compactList", "the synced choice wins over the inference");
  assert.notEqual(d.published().tabSwitcherView, "none");
  const e = new Device("E", folder);
  await e.sync();
  assert.equal(e.modes().tabSwitcherView, "compactList", "and no other Mac is overwritten");
});
