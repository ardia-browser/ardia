import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { useEditClock } = await import("./editClock.ts");
const { settingsAdapter, settleSettingsFromSavedSync } = await import("./settingsAdapter.ts");
const { chooseSidebarMode } = await import("../settings/actions.ts");
const { chosenSidebarMode } = await import("../browser/model.ts");

const S = () => useBrowser.getState();

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

const MODE = "set:sidebarMode";
const legacyAdapter = {
  ...settingsAdapter,
  extract: (...args) => {
    const out = settingsAdapter.extract(...args);
    out.values.delete(MODE);
    return { values: out.values, ignore: (key) => key === MODE || out.ignore(key) };
  },
  apply: (visible, changed, base, records) => settingsAdapter.apply(new Map([...visible].filter(([k]) => k !== MODE)), new Set([...changed].filter((k) => k !== MODE)), base, records),
};

class Device {
  constructor(id, folder, adapter = settingsAdapter) {
    this.id = id;
    this.folder = folder;
    this.adapter = adapter;
    S().hydrate({});
    this.browser = S();
    this.scope = emptyScope();
    this.clock = new Clock(id);
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
      await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: [this.adapter], clock: this.clock, device: this.id });
    } finally {
      this.browser = S();
    }
  }
  mode() {
    return this.with(() => chosenSidebarMode(S().settings));
  }
}

async function joined() {
  const folder = new Folder();
  const a = new Device("A", folder);
  const b = new Device("B", folder);
  await a.sync();
  await b.sync();
  return { a, b };
}

const choice = (d) => d.with(() => [chosenSidebarMode(S().settings), S().settings.collapsedSidebar].join(" "));

test("two Macs picking at once end on one Mac's whole choice, never Full from one and Hidden's style from the other", async () => {
  const { a, b } = await joined();
  a.with(() => chooseSidebarMode("icons"));
  await a.sync();
  await b.sync();
  assert.equal(b.mode(), "icons");
  a.with(() => chooseSidebarMode("full"));
  await a.sync();
  b.with(() => chooseSidebarMode("hidden"));
  await b.sync();
  await a.sync();
  await b.sync();
  assert.equal(choice(a), choice(b), "both Macs agree");
  assert.ok(["full icons", "hidden hidden"].includes(choice(a)), `one Mac's pick as a whole, got ${choice(a)}`);
});

test("a newer Full pick keeps the collapsed style both Macs remember, so the next ⌘S collapses to Icons everywhere", async () => {
  const { a, b } = await joined();
  a.with(() => chooseSidebarMode("icons"));
  await a.sync();
  await b.sync();
  assert.equal(b.mode(), "icons");
  b.with(() => chooseSidebarMode("full"));
  await b.sync();
  await a.sync();
  assert.deepEqual([a.mode(), b.mode()], ["full", "full"]);
  assert.deepEqual([a.with(() => S().settings.collapsedSidebar), b.with(() => S().settings.collapsedSidebar)], ["icons", "icons"]);
});

test("an older Mac's newer Full, which only writes the auto-hide switch, wins over an earlier Icons pick and keeps Icons as the style", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  const old = new Device("O", folder, legacyAdapter);
  await a.sync();
  await old.sync();
  a.with(() => chooseSidebarMode("icons"));
  await a.sync();
  await old.sync();
  assert.equal(old.with(() => S().settings.autoHideTabs), true);
  old.with(() => S().updateSettings({ autoHideTabs: false }));
  await old.sync();
  await a.sync();
  assert.equal(a.mode(), "full");
  assert.equal(a.with(() => S().settings.collapsedSidebar), "icons", "⌘S still collapses to Icons");
});

test("a Mac that pulled an Icons pick before it upgraded shows Icons once it has", async () => {
  const folder = new Folder();
  const a = new Device("A", folder);
  const d = new Device("D", folder, legacyAdapter);
  await a.sync();
  await d.sync();
  a.with(() => chooseSidebarMode("icons"));
  await a.sync();
  await d.sync();
  assert.equal(d.mode(), "hidden", "the old build only knows collapsed");
  d.adapter = settingsAdapter;
  d.with(() => settleSettingsFromSavedSync(d.scope, true));
  await d.sync();
  assert.equal(d.mode(), "icons");
});

test("a batch without the sidebar records leaves a pick made since the last publish alone", async () => {
  S().hydrate({});
  chooseSidebarMode("full");
  const visible = new Map([[MODE, { v: { collapsed: true, style: "icons" } }], ["set:autoHideTabs", { v: true }], ["set:searchSuggestions", { v: false }]]);
  await settingsAdapter.apply(visible, new Set(["set:searchSuggestions"]), () => undefined, { stamp: () => undefined });
  assert.equal(chosenSidebarMode(S().settings), "full");
  assert.equal(S().settings.searchSuggestions, false);
});
