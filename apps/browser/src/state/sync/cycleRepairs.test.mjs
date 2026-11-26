import assert from "node:assert/strict";
import { test } from "node:test";

let nextCycle = null;
globalThis.setTimeout = (fn, ms) => {
  if (ms !== 1000) nextCycle = fn;
  return 0;
};
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const passwordReads = [];
let heldScope = null;
let held = null;
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `id${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      if (scope === heldScope) {
        await new Promise((release) => (held = release));
        heldScope = null;
      }
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async (profile) => (passwordReads.push(profile), []),
  },
};

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { emptyScope, canonical } = await import("@ardia/sync");
const S = () => useBrowser.getState();
const reset = () => {
  shell.docs.clear();
  folder.clear();
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
};
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function runScheduledCycle() {
  const run = nextCycle;
  nextCycle = null;
  run();
  for (let i = 0; i < 200 && !nextCycle; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(nextCycle, "the cycle ends and schedules the next");
  await settle(5);
}

test("a cycle within the read interval leaves passwords alone, and Sync Now reads them", async () => {
  reset();
  const engine = await import("./engine.ts?interval");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();
  passwordReads.length = 0;
  await runScheduledCycle();
  assert.equal(passwordReads.length, 0, "a regular cycle waits out the interval");
  await engine.syncNow();
  assert.ok(passwordReads.length > 0, "Sync Now reads them anyway");
});

test("Sync Now pressed while a cycle runs reads every profile's passwords in the cycle that follows", async () => {
  reset();
  const work = S().createProfile({ name: "Work" });
  const engine = await import("./engine.ts?queued");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();
  const links = engine.useSync.getState().profiles;
  assert.ok(links.default && links[work], "both profiles sync");

  heldScope = `p:${links[work].syncId}`;
  const running = runScheduledCycle();
  await settle();
  assert.ok(held, "the regular cycle is reading the second profile");
  passwordReads.length = 0;
  void engine.syncNow();
  held();
  held = null;
  await running;
  await runScheduledCycle();
  assert.ok(passwordReads.includes(engineProfile(S(), "default")), "the first profile's passwords are read after the click");
  assert.ok(passwordReads.includes(engineProfile(S(), work)), "and the second's");
});

const GLOW = "set:selectedTabGlow";

function savedFromOlderBuild({ settings, chosen = false }) {
  const record = { h: "0000000001000.0000.peer", v: { v: "off" }, o: ["peer", 1] };
  const app = { ...emptyScope(), records: { [GLOW]: record }, base: { [GLOW]: canonical(record.v) }, vv: { peer: 1 }, joined: true, seen: { peer: 1 } };
  shell.docs.set("sync-state.nns", `sealed:${JSON.stringify({ covers: -1, scopes: { app }, version: 1 })}`);
  const doc = { v: 1, enabled: true, folder: "/sync", deviceId: "me", clock: null, types: { bookmarks: true, history: true, tabs: true, pinned: true, passwords: true, extensions: true, settings }, profiles: {}, lastSyncedAt: null, setupAt: 1, joining: false };
  shell.docs.set("sync.json", JSON.stringify(doc));
  if (chosen) S().updateSettings({ selectedTabGlow: "soft" });
}

const published = (key) => [...folder.values()].map((f) => JSON.parse(f.payload)).some((f) => f.ops?.some((op) => op.k === key));

test("a setting an older build received but didn't sync lands after the upgrade, as a synced value", async () => {
  reset();
  savedFromOlderBuild({ settings: true });
  const engine = await import("./engine.ts?upgrade");
  engine.startSync();
  await settle();
  await engine.syncNow();
  assert.equal(S().settings.selectedTabGlow, "off", "the synced value takes effect");
  assert.ok(!S().settingsMeta.chosen.includes("selectedTabGlow"), "not as a choice made here");
  await engine.syncNow();
  assert.ok(!published(GLOW), "and nothing goes back out");
});

test("with settings sync off at the upgrade, the setting lands once settings sync is turned on", async () => {
  reset();
  savedFromOlderBuild({ settings: false });
  const engine = await import("./engine.ts?upgradeOff");
  engine.startSync();
  await settle();
  await engine.syncNow();
  assert.equal(S().settings.selectedTabGlow, "full", "nothing applies while settings sync is off");
  engine.setTypeSynced("settings", true);
  await engine.syncNow();
  assert.equal(S().settings.selectedTabGlow, "off", "it applies once it's on");
});

test("a setting chosen on this Mac isn't replaced by the one an older build received", async () => {
  reset();
  savedFromOlderBuild({ settings: true, chosen: true });
  const engine = await import("./engine.ts?chosen");
  engine.startSync();
  await settle();
  await engine.syncNow();
  await engine.syncNow();
  assert.equal(S().settings.selectedTabGlow, "soft");
});

const GROUPING = "set:cmdClickCreatesTabGroup";
const GROUPING_RETIRED = "cmdClickCreatesTabGroup:offByDefault";
const { loadSession, SESSION_VERSION } = await import("../session/persist.ts");
const { settingsSyncWaitsAtLaunch } = await import("./settingsSyncAtLaunch.ts");
const { asSecret } = await import("@ardia/core");

function upgradeWithGroupingOn({ settings, synced, meta = { chosen: [], inferred: [] } }) {
  reset();
  const record = { h: "0000000001000.0000.peer", v: { v: synced }, o: ["peer", 1] };
  const app = { ...emptyScope(), records: synced === undefined ? {} : { [GROUPING]: record }, base: synced === undefined ? {} : { [GROUPING]: canonical(record.v) }, vv: { peer: 1 }, joined: true, seen: { peer: 1 } };
  shell.docs.set("sync-state.nns", `sealed:${JSON.stringify({ covers: -1, scopes: { app }, version: 1 })}`);
  shell.docs.set("sync.json", JSON.stringify({ v: 1, enabled: true, folder: "/sync", deviceId: "me", clock: null, types: { bookmarks: true, history: true, tabs: true, pinned: true, passwords: true, extensions: true, settings }, profiles: {}, lastSyncedAt: null, setupAt: 1, joining: false }));
  const profile = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
  shell.docs.set("session.json", JSON.stringify({ version: SESSION_VERSION, profiles: { default: profile }, profileOrder: ["default"], settings: { ...S().settings, cmdClickCreatesTabGroup: true }, settingsMeta: { chosen: meta.chosen, inferred: [...meta.inferred, "hideToolbarWhileScrolling:offByDefault"] }, windows: [], windowOrder: [], tabs: [], groups: [], splits: [], closedTabs: [], closedWindows: [] }));
  S().hydrate(loadSession({ retiredDefaultsWaitForSync: settingsSyncWaitsAtLaunch() }));
}
const grouping = () => ({ on: S().settings.cmdClickCreatesTabGroup, retired: S().settingsMeta.inferred.includes(GROUPING_RETIRED) });

test("at launch the retired grouping default waits only while Settings sync is on, then settles from the unlocked saved state", async () => {
  upgradeWithGroupingOn({ settings: true, synced: true });
  assert.deepEqual(grouping(), { on: true, retired: false }, "sync is still locked: nothing flips and nothing is marked");
  const engine = await import("./engine.ts?groupingHeld");
  engine.startSync();
  await settle();
  assert.deepEqual(grouping(), { on: true, retired: true }, "the unlocked record holds an on: it stays on, now marked");
  assert.ok(!S().settingsMeta.chosen.includes("cmdClickCreatesTabGroup"));
});

test("unlocked with no grouping record, the waiting on retires to off", async () => {
  upgradeWithGroupingOn({ settings: true, synced: undefined });
  const engine = await import("./engine.ts?groupingAbsent");
  engine.startSync();
  await settle();
  assert.deepEqual(grouping(), { on: false, retired: true });
});

test("a key that stays locked leaves the waiting on alone", async () => {
  const sync = globalThis.acTestNativeModules.ArdiaSync;
  const unlock = sync.unlock;
  sync.unlock = async () => false;
  try {
    upgradeWithGroupingOn({ settings: true, synced: true });
    const engine = await import("./engine.ts?groupingLocked");
    engine.startSync();
    await settle();
    assert.deepEqual(grouping(), { on: true, retired: false });
  } finally {
    sync.unlock = unlock;
  }
});

test("with Settings sync off at launch the old on retires during hydration, and the saved on record never brings it back", async () => {
  upgradeWithGroupingOn({ settings: false, synced: true });
  assert.deepEqual(grouping(), { on: false, retired: true });
  const engine = await import("./engine.ts?groupingTypeOff");
  engine.startSync();
  await settle();
  assert.deepEqual(grouping(), { on: false, retired: true });
});

async function withSyncNative(overrides, run) {
  const sync = globalThis.acTestNativeModules.ArdiaSync;
  const kept = Object.fromEntries(Object.keys(overrides).map((k) => [k, sync[k]]));
  Object.assign(sync, overrides);
  try {
    await run();
  } finally {
    Object.assign(sync, kept);
  }
}

test("stopping sync while the saved state is still being read never lets the late read keep the waiting on", async () => {
  let release;
  const opening = new Promise((resolve) => (release = resolve));
  const sync = globalThis.acTestNativeModules.ArdiaSync;
  const open = sync.openLocal;
  await withSyncNative({ openLocal: async (sealed) => (await opening, open(sealed)) }, async () => {
    upgradeWithGroupingOn({ settings: true, synced: true });
    const engine = await import("./engine.ts?groupingStopDuringRead");
    engine.startSync();
    await settle();
    assert.deepEqual(grouping(), { on: true, retired: false }, "the read is still out");
    const stopping = engine.stopSync();
    await settle();
    release();
    await stopping;
    await settle();
    assert.equal(engine.useSync.getState().status, "off");
    assert.deepEqual(grouping(), { on: false, retired: true });
  });
});

test("turning Settings sync off while the key is locked retires the waiting on at once", async () => {
  await withSyncNative({ unlock: async () => false }, async () => {
    upgradeWithGroupingOn({ settings: true, synced: true });
    const engine = await import("./engine.ts?groupingTypeOffLocked");
    engine.startSync();
    await settle();
    assert.deepEqual(grouping(), { on: true, retired: false });
    engine.setTypeSynced("settings", false);
    assert.deepEqual(grouping(), { on: false, retired: true });
  });
});

test("stopping all sync while the key is locked retires the waiting on at once", async () => {
  await withSyncNative({ unlock: async () => false }, async () => {
    upgradeWithGroupingOn({ settings: true, synced: true });
    const engine = await import("./engine.ts?groupingStopLocked");
    engine.startSync();
    await settle();
    assert.equal(engine.useSync.getState().status, "locked");
    await engine.stopSync();
    assert.deepEqual(grouping(), { on: false, retired: true });
  });
});

test("an on from before Ardia tracked choices (chosen and inferred) waits at launch and keeps its synced on at unlock, now unchosen", async () => {
  upgradeWithGroupingOn({ settings: true, synced: true, meta: { chosen: ["cmdClickCreatesTabGroup"], inferred: ["cmdClickCreatesTabGroup"] } });
  assert.deepEqual(grouping(), { on: true, retired: false });
  const engine = await import("./engine.ts?groupingLegacy");
  engine.startSync();
  await settle();
  assert.deepEqual(grouping(), { on: true, retired: true });
  assert.ok(!S().settingsMeta.chosen.includes("cmdClickCreatesTabGroup") && !S().settingsMeta.inferred.includes("cmdClickCreatesTabGroup"));
});

test("a checkpoint read from a superseded sync session is dropped: stopping /old and starting /new never brings /old's grouping record along", async () => {
  let release;
  const opening = new Promise((resolve) => (release = resolve));
  const sync = globalThis.acTestNativeModules.ArdiaSync;
  const open = sync.openLocal;
  let holdOpen = false;
  await withSyncNative({ unlock: async () => false, enterPhrase: async () => ({ ok: true }), openLocal: async (sealed) => (holdOpen && (await opening), open(sealed)) }, async () => {
    upgradeWithGroupingOn({ settings: true, synced: true });
    const engine = await import("./engine.ts?groupingOldToNew");
    engine.startSync();
    await settle();
    assert.equal(engine.useSync.getState().status, "locked");
    holdOpen = true;
    const recovering = engine.enterRecoveryPhrase("/old", asSecret("syncPhrase", "words"));
    await settle();
    await engine.stopSync();
    assert.deepEqual(grouping(), { on: false, retired: true }, "stopping settles the waiting on");
    holdOpen = false;
    assert.ok("ok" in (await engine.turnOnSync("/new")));
    release();
    await recovering;
    await settle();
    assert.equal(engine.appScopeRecords()[GROUPING], undefined, "/new's state holds nothing from /old");
    await engine.syncNow();
    await settle();
    assert.deepEqual(grouping(), { on: false, retired: true }, "and the next cycle doesn't turn grouping back on");
  });
});

test("a cached off for an on from before Ardia tracked choices (chosen and inferred) applies and leaves it neither chosen nor inferred", async () => {
  upgradeWithGroupingOn({ settings: true, synced: false, meta: { chosen: ["cmdClickCreatesTabGroup"], inferred: ["cmdClickCreatesTabGroup"] } });
  assert.deepEqual(grouping(), { on: true, retired: false });
  const engine = await import("./engine.ts?groupingLegacyOff");
  engine.startSync();
  await settle();
  assert.deepEqual(grouping(), { on: false, retired: true });
  assert.ok(!S().settingsMeta.chosen.includes("cmdClickCreatesTabGroup") && !S().settingsMeta.inferred.includes("cmdClickCreatesTabGroup"));
});

test("while Settings sync waits, only ⌘-click grouping waits: the hide-toolbar-while-scrolling on still retires at hydration", () => {
  upgradeWithGroupingOn({ settings: true, synced: true });
  reset();
  const profile = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
  shell.docs.set("session.json", JSON.stringify({ version: SESSION_VERSION, profiles: { default: profile }, profileOrder: ["default"], settings: { ...S().settings, cmdClickCreatesTabGroup: true, hideToolbarWhileScrolling: true }, settingsMeta: { chosen: [], inferred: [] }, windows: [], windowOrder: [], tabs: [], groups: [], splits: [], closedTabs: [], closedWindows: [] }));
  S().hydrate(loadSession({ retiredDefaultsWaitForSync: true }));
  assert.deepEqual(grouping(), { on: true, retired: false });
  assert.equal(S().settings.hideToolbarWhileScrolling, false);
  assert.ok(S().settingsMeta.inferred.includes("hideToolbarWhileScrolling:offByDefault"));
});
