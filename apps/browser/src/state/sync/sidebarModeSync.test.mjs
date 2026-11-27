import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { useEditClock } = await import("./editClock.ts");
const { settingsAdapter, settleSettingsFromSavedSync } = await import("./settingsAdapter.ts");
const { inTodaysNames } = await import("./adapters.ts");
const { withSettingEdits } = await import("./settingEdits.ts");
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

const COLLAPSED = "set:autoHideTabs";
const STYLE = "set:collapsedSidebar";
const KEYS = [COLLAPSED, STYLE];
const appAdapter = withSettingEdits(inTodaysNames(settingsAdapter));
const mergeBaseAdapter = {
  ...appAdapter,
  extract: async (...args) => {
    const out = await appAdapter.extract(...args);
    out.values.delete(STYLE);
    return { ...out, ignore: (key) => key === STYLE || out.ignore(key) };
  },
  apply: (visible, changed, base, records) => appAdapter.apply(new Map([...visible].filter(([k]) => k !== STYLE)), new Set([...changed].filter((k) => k !== STYLE)), base, records),
};

class Device {
  constructor(id, folder, { legacy = false, clockAhead = 0 } = {}) {
    this.id = id;
    this.folder = folder;
    this.legacy = legacy;
    S().hydrate({});
    this.browser = S();
    this.scope = emptyScope();
    this.clock = new Clock(id, null, () => Date.now() + clockAhead);
  }
  get adapter() {
    return this.legacy ? mergeBaseAdapter : appAdapter;
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
  pick(mode, tabsOnTop) {
    if (this.legacy) this.with(() => S().updateSettings({ autoHideTabs: mode !== "full" }));
    else this.with(() => chooseSidebarMode(mode, tabsOnTop));
  }
  relaunch() {
    this.with(() => settleSettingsFromSavedSync(this.scope, true));
  }
  upgrade() {
    this.legacy = false;
    this.relaunch();
  }
  state() {
    return this.with(() => (this.legacy ? { collapsed: S().settings.autoHideTabs } : { collapsed: S().settings.autoHideTabs, style: S().settings.collapsedSidebar, mode: chosenSidebarMode(S().settings) }));
  }
  records() {
    return Object.fromEntries(KEYS.filter((k) => this.scope.records[k]).map((k) => [k, { h: this.scope.records[k].h, v: this.scope.records[k].v }]));
  }
}

async function network(...specs) {
  const folder = new Folder();
  const devices = specs.map(([id, options]) => new Device(id, folder, options));
  for (const d of devices) await d.sync();
  return { folder, devices };
}

async function settle(devices) {
  for (let round = 0; round < 3; round++) for (const d of devices) await d.sync();
}

function assertConverged(devices) {
  const first = devices[0].records();
  for (const d of devices) assert.deepEqual(d.records(), first, `${d.id} holds the same records`);
  const current = devices.filter((d) => !d.legacy);
  for (const d of current) assert.deepEqual(d.state(), current[0].state(), `${d.id} shows what ${current[0].id} shows`);
  for (const d of devices) assert.equal(d.state().collapsed, devices[0].state().collapsed, `${d.id} agrees on collapsed`);
}

async function later() {
  const from = Date.now();
  while (Date.now() <= from + 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a pick writes both settings in one change: Icons and Hidden set collapsed and the style, Full only uncollapses", async () => {
  const { devices } = await network(["A"], ["B"]);
  const [a, b] = devices;
  a.pick("icons");
  await a.sync();
  const picked = a.records();
  assert.deepEqual([picked[COLLAPSED].v.v, picked[STYLE].v.v], [true, "icons"]);
  assert.equal(picked[COLLAPSED].h.split(".").slice(0, 1)[0], picked[STYLE].h.split(".").slice(0, 1)[0], "one change, one moment");
  await b.sync();
  assert.equal(b.state().mode, "icons");
  await later();
  b.pick("full");
  await b.sync();
  await a.sync();
  assert.deepEqual(a.state(), { collapsed: false, style: "icons", mode: "full" }, "Full keeps the style, so the next ⌘S collapses to Icons");
  assertConverged(devices);
});

test("an older Mac's newer Full, which only writes the auto-hide switch, wins over an earlier Icons pick on every Mac", async () => {
  const { devices } = await network(["A"], ["O", { legacy: true }]);
  const [a, old] = devices;
  a.pick("icons");
  await settle(devices);
  await later();
  old.pick("full");
  await settle(devices);
  assert.deepEqual(a.state(), { collapsed: false, style: "icons", mode: "full" });
  assertConverged(devices);
  old.upgrade();
  await settle(devices);
  assertConverged(devices);
});

test("a Mac that received an Icons pick before it upgraded shows Icons after, and publishes nothing for it", async () => {
  const { devices } = await network(["A"], ["O", { legacy: true }]);
  const [a, old] = devices;
  old.pick("hidden");
  await settle(devices);
  await later();
  a.pick("icons");
  await settle(devices);
  assert.equal(old.state().collapsed, true, "the old build only knows collapsed");
  const before = a.records();
  old.upgrade();
  await settle(devices);
  assert.equal(old.state().mode, "icons");
  assert.deepEqual(a.records(), before, "the upgrade wrote nothing");
  assertConverged(devices);
});

test("an idle sync never republishes Full over a later Hidden pick from another Mac", async () => {
  const { devices } = await network(["A"], ["B"], ["O", { legacy: true }]);
  const [a, b] = devices;
  a.pick("icons");
  await settle(devices);
  await later();
  devices[2].pick("full");
  await settle(devices);
  assert.equal(a.state().mode, "full");
  await later();
  b.pick("hidden");
  await b.sync();
  await settle(devices);
  assert.deepEqual(a.state(), { collapsed: true, style: "hidden", mode: "hidden" });
  assertConverged(devices);
});

test("concurrent picks, Full on one Mac and Hidden on another before it pulls the Full, end the same on every Mac", async () => {
  const { devices } = await network(["A"], ["B"], ["C"]);
  const [a, b] = devices;
  a.pick("icons");
  await settle(devices);
  await later();
  a.pick("full");
  b.pick("hidden");
  await a.sync();
  await b.sync();
  await settle(devices);
  assertConverged(devices);
  for (const d of devices) d.relaunch();
  await settle(devices);
  assertConverged(devices);
});

test("with one Mac's clock five minutes ahead, a pick made after seeing its choice still wins, and a relaunch keeps it", async () => {
  const { devices } = await network(["A"], ["F", { clockAhead: 5 * 60_000 }]);
  const [a, fast] = devices;
  fast.pick("icons");
  await settle(devices);
  a.pick("hidden");
  await settle(devices);
  assert.deepEqual([a.state().mode, fast.state().mode], ["hidden", "hidden"]);
  for (const d of devices) d.relaunch();
  await settle(devices);
  assert.deepEqual([a.state().mode, fast.state().mode], ["hidden", "hidden"]);
  assertConverged(devices);
});

test("two picks in the same millisecond on one Mac go out as the last one, and two Macs picking in the same millisecond converge", async () => {
  const { devices } = await network(["A"], ["B"]);
  const [a, b] = devices;
  const at = Date.now();
  a.pick("icons");
  a.pick("hidden");
  b.pick("icons");
  assert.ok(Date.now() - at < 5);
  await settle(devices);
  assertConverged(devices);
  for (const d of devices) d.relaunch();
  await settle(devices);
  assertConverged(devices);
  await later();
  a.pick("hidden");
  a.pick("icons");
  await settle(devices);
  assert.deepEqual([a.state().mode, b.state().mode], ["icons", "icons"]);
});

test("an idle sync with no pick writes nothing, before or after a pick has synced", async () => {
  const { folder, devices } = await network(["A"], ["B"], ["O", { legacy: true }]);
  const written = () => folder.counter;
  const start = written();
  await settle(devices);
  for (const d of devices) d.relaunch();
  await settle(devices);
  assert.equal(written(), start, "no pick, no file");
  assert.deepEqual(devices[0].records(), {});
  devices[0].pick("icons");
  await settle(devices);
  const after = written();
  for (const d of devices) d.relaunch();
  await settle(devices);
  assert.equal(written(), after, "idle and relaunched Macs write nothing more");
  assertConverged(devices);
});

test("picking Hidden with tabs across the top leaves the synced style alone", async () => {
  const { devices } = await network(["A"], ["B"]);
  const [a, b] = devices;
  a.pick("icons");
  await settle(devices);
  await later();
  b.pick("full", true);
  await later();
  b.pick("hidden", true);
  await settle(devices);
  assert.deepEqual(a.state(), { collapsed: true, style: "icons", mode: "icons" });
  assertConverged(devices);
});

test("a pick made in the same millisecond as the record it follows still wins on every Mac, and a relaunch keeps it", async () => {
  const real = Date.now;
  const frozen = real();
  Date.now = () => frozen;
  try {
    const { devices } = await network(["A"], ["B"]);
    const [a, b] = devices;
    a.pick("icons");
    await settle(devices);
    b.pick("hidden");
    await settle(devices);
    assert.deepEqual([a.state().mode, b.state().mode], ["hidden", "hidden"]);
    for (const d of devices) d.relaunch();
    await settle(devices);
    assert.deepEqual([a.state().mode, b.state().mode], ["hidden", "hidden"]);
    assertConverged(devices);
  } finally {
    Date.now = real;
  }
});

for (const apart of [false, true])
  test(`Full published on one Mac and Hidden picked on another before it pulls it converge${apart ? ", a millisecond apart" : ""}`, async () => {
    const { devices } = await network(["A"], ["B"], ["O", { legacy: true }]);
    const [a, b] = devices;
    a.pick("icons");
    await settle(devices);
    await later();
    a.pick("full");
    await a.sync();
    if (apart) await later();
    b.pick("hidden");
    await b.sync();
    await settle(devices);
    assertConverged(devices);
    for (const d of devices) d.relaunch();
    await settle(devices);
    assertConverged(devices);
  });

for (const order of ["A publishes first", "B publishes first"])
  test(`from Icons, Full picked on one Mac and Hidden on another a minute later end on Hidden everywhere (${order})`, async () => {
    const real = Date.now;
    let now = real();
    Date.now = () => now;
    try {
      const { devices } = await network(["A"], ["B"], ["C"]);
      const [a, b] = devices;
      a.pick("icons");
      await settle(devices);
      now += 1000;
      a.pick("full");
      now += 60_000;
      b.pick("hidden");
      now += 1000;
      for (const d of order === "A publishes first" ? [a, b] : [b, a]) await d.sync();
      await settle(devices);
      for (const d of devices) assert.equal(d.state().mode, "hidden", `${d.id} after syncing`);
      for (const d of devices) d.relaunch();
      await settle(devices);
      for (const d of devices) assert.equal(d.state().mode, "hidden", `${d.id} after a relaunch`);
      assertConverged(devices);
    } finally {
      Date.now = real;
    }
  });
