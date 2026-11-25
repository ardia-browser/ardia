import assert from "node:assert/strict";
import test from "node:test";
import { createUtilitySessionSnapshot, initialLinuxSession } from "./session.ts";
import { SNIFFED_SESSION_VERSION, linuxSessionShape, linuxSessionVersion, snapshotHostSession, startHostPersistence } from "./hostSession.ts";
import { mergeSession } from "./hostSessionMerge.ts";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { SESSION_MIGRATIONS, SESSION_VERSION } from "../../browser/src/state/session/persist.ts";

const host = (windowId = "main") => ({ bootstrap: { windowId, profileId: "default", startup: false } });

function olderSession(settings = {}, settingsMeta = { chosen: [], inferred: [] }) {
  const saved = initialLinuxSession(host(), null);
  saved.settings = { restoreSession: true, sidebarWidth: 256, autoHideTabs: false, showUnreadCounts: true, ...settings };
  saved.settingsMeta = settingsMeta;
  Object.values(saved.tabs)[0].url = "https://example.test/inbox";
  return saved;
}

test("a session saved before Show unread counts went off by default turns an untouched setting off, and keeps a chosen one", () => {
  const untouched = olderSession();
  assert.equal(linuxSessionVersion(untouched), undefined);
  const shaped = linuxSessionShape(untouched);
  assert.equal(linuxSessionVersion(shaped), SESSION_VERSION);
  assert.equal("showUnreadCounts" in shaped.settings, false);
  assert.equal(shaped.settings.sidebarWidth, 256);
  assert.deepEqual(shaped.tabs, untouched.tabs);
  assert.deepEqual(shaped.windows, untouched.windows);
  assert.equal(untouched.settings.showUnreadCounts, true);
  useBrowser.getState().hydrate(initialLinuxSession(host(), untouched));
  assert.equal(useBrowser.getState().settings.showUnreadCounts, false);

  const chosen = olderSession({}, { chosen: ["showUnreadCounts"], inferred: [] });
  assert.equal(linuxSessionShape(chosen).settings.showUnreadCounts, true);
  useBrowser.getState().hydrate(initialLinuxSession(host(), chosen));
  assert.equal(useBrowser.getState().settings.showUnreadCounts, true);

  const inferred = olderSession({}, { chosen: ["showUnreadCounts"], inferred: ["showUnreadCounts"] });
  const settled = linuxSessionShape(inferred);
  assert.equal("showUnreadCounts" in settled.settings, false);
  assert.deepEqual(settled.settingsMeta, { chosen: [], inferred: [] });
});

test("a session already at the shared version is left exactly as saved", () => {
  const current = { ...olderSession(), version: SESSION_VERSION };
  assert.equal(linuxSessionShape(current), current);
  assert.equal(current.settings.showUnreadCounts, true);
  const newer = { ...olderSession(), version: SESSION_VERSION + 1 };
  assert.equal(linuxSessionShape(newer), newer);
});

test("every shared migration after the saved version runs, in order, on the shape the Mac saves", () => {
  const seen = [];
  const original = { ...SESSION_MIGRATIONS };
  const added = SESSION_VERSION;
  const table = SESSION_MIGRATIONS;
  try {
    for (const step of Object.keys(original)) {
      Object.defineProperty(table, step, { configurable: true, enumerable: true, writable: true, value: (doc) => { seen.push(Number(step)); return original[step](doc); } });
    }
    const saved = olderSession({ littleArdiaOpensNewTabLinks: false });
    const shaped = linuxSessionShape(saved);
    assert.deepEqual(seen, Array.from({ length: added - SNIFFED_SESSION_VERSION }, (_, i) => SNIFFED_SESSION_VERSION + i));
    assert.equal("littleArdiaOpensNewTabLinks" in shaped.settings, false);
    seen.length = 0;
    const stampedOneBehind = linuxSessionShape({ ...olderSession({ littleArdiaOpensNewTabLinks: false }), version: added - 1 });
    assert.deepEqual(seen, [added - 1]);
    assert.equal(stampedOneBehind.settings.littleArdiaOpensNewTabLinks, false);
    assert.equal("showUnreadCounts" in stampedOneBehind.settings, false);

    seen.length = 0;
    let received;
    Object.defineProperty(table, added - 1, { configurable: true, enumerable: true, writable: true, value: (doc) => {
      received = doc;
      return { ...doc, tabs: doc.tabs.map((tab) => ({ ...tab, title: "Renamed by a migration" })), windows: doc.windows.map((w) => ({ ...w, migrated: true })) };
    } });
    const reshaped = linuxSessionShape({ ...olderSession(), version: added - 1 });
    for (const list of ["windows", "tabs", "groups", "splits"]) if (list in received) assert.ok(Array.isArray(received[list]), list);
    assert.equal(received.version, added - 1);
    assert.deepEqual(Object.values(reshaped.tabs).map((tab) => tab.title), ["Renamed by a migration"]);
    assert.deepEqual(Object.keys(reshaped.tabs), Object.values(reshaped.tabs).map((tab) => tab.id));
    assert.equal(reshaped.windows.main.migrated, true);
    assert.equal(linuxSessionVersion(reshaped), SESSION_VERSION);
  } finally {
    for (const step of Object.keys(original)) Object.defineProperty(table, step, { configurable: true, enumerable: true, writable: true, value: original[step] });
  }
});

test("a migration that fails leaves the saved session as it was", () => {
  const original = SESSION_MIGRATIONS[SESSION_VERSION - 1];
  Object.defineProperty(SESSION_MIGRATIONS, SESSION_VERSION - 1, { configurable: true, enumerable: true, writable: true, value: () => null });
  try {
    const saved = olderSession();
    const shaped = linuxSessionShape(saved);
    assert.equal(shaped.settings.showUnreadCounts, true);
    assert.equal(linuxSessionVersion(shaped), undefined);
  } finally {
    Object.defineProperty(SESSION_MIGRATIONS, SESSION_VERSION - 1, { configurable: true, enumerable: true, writable: true, value: original });
  }
});

test("every snapshot carries the shared session version", () => {
  useBrowser.getState().hydrate(initialLinuxSession(host(), olderSession()));
  assert.equal(linuxSessionVersion(snapshotHostSession(useBrowser.getState())), SESSION_VERSION);
});

function persistenceRig(stored, snapshot = undefined, windowId = "main") {
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  let disk = structuredClone(stored);
  let deliver = () => {};
  const writes = [];
  const native = {
    ...host(windowId),
    async invoke(method, pair) {
      if (method === "session.read") return disk;
      assert.equal(method, "session.write");
      writes.push(structuredClone(pair));
      disk = mergeSession(pair.base, pair.session, disk);
      return disk;
    },
    onEvent: (listener) => ((deliver = listener), () => {}),
    onBeforeClose: () => () => {},
  };
  useBrowser.getState().hydrate(initialLinuxSession(native, stored));
  const stop = startHostPersistence(native, useBrowser, stored, snapshot?.());
  const edit = (change) => (disk = change(structuredClone(disk)));
  const peerWrites = (change) => {
    const base = structuredClone(disk);
    deliver("ArdiaHost", "session", { base, session: structuredClone(edit(change)), sourceWindowId: "peer" });
  };
  return { writes, stop, disk: () => disk, edit, peerWrites, restore() { stop(); globalThis.window = savedWindow; globalThis.document = savedDocument; } };
}

test("a migrated session is saved at once against what was on disk, so the next launch has nothing to migrate", async () => {
  const rig = persistenceRig(olderSession());
  try {
    await rig.stop.flush();
    assert.equal(rig.writes.length, 1);
    const [{ base, session }] = rig.writes;
    assert.equal(linuxSessionVersion(base), undefined);
    assert.equal(base.settings.showUnreadCounts, true);
    assert.equal(linuxSessionVersion(session), SESSION_VERSION);
    assert.equal(session.settings.showUnreadCounts, false);
    assert.equal(linuxSessionVersion(rig.disk()), SESSION_VERSION);
    assert.equal(rig.disk().settings.showUnreadCounts, false);
    assert.equal(linuxSessionShape(rig.disk()), rig.disk());
    useBrowser.getState().updateSettings({ showUnreadCounts: true });
    await rig.stop.flush();
    assert.equal(rig.disk().settings.showUnreadCounts, true);
    assert.equal(linuxSessionShape(rig.disk()).settings.showUnreadCounts, true);
  } finally {
    rig.restore();
  }
});

test("a session that only lacks the version stamp launches like a stamped one, and has the stamp after its next save", async (context) => {
  const savedAt = 1700000000000;
  context.mock.timers.enable({ apis: ["Date"], now: savedAt });
  const first = persistenceRig(olderSession({ showUnreadCounts: false }));
  await first.stop.flush();
  first.restore();
  const settled = first.disk();
  const launchWrites = async (stored) => {
    const rig = persistenceRig(stored);
    try {
      await rig.stop.flush();
      return rig.writes.length;
    } finally {
      rig.restore();
    }
  };
  const { version: _, ...unstamped } = settled;
  assert.deepEqual([await launchWrites(unstamped), await launchWrites(settled)], [0, 0]);
  context.mock.timers.tick(1);
  assert.deepEqual([await launchWrites(unstamped), await launchWrites(settled)], [1, 1]);
  const rig = persistenceRig(unstamped);
  try {
    useBrowser.getState().updateSettings({ sidebarWidth: 300 });
    await rig.stop.flush();
    assert.equal(linuxSessionVersion(rig.disk()), SESSION_VERSION);
    assert.equal(rig.disk().settings.sidebarWidth, 300);
    assert.equal(rig.disk().settings.showUnreadCounts, false);
  } finally {
    rig.restore();
  }
});

test("malformed pin choices don't stop the launch, and only well-formed ones are shared between windows", () => {
  const launchWith = (pinChoices) => {
    const saved = { ...olderSession(), version: SESSION_VERSION, pinChoices };
    useBrowser.getState().hydrate(initialLinuxSession(host(), saved));
    assert.deepEqual(useBrowser.getState().windowOrder, ["main"]);
    return linuxSessionShape(saved).pinChoices;
  };
  const kept = { key: "0mwo1usf5.0001." };
  for (const bad of [null, 7, "stamp", [], [null]]) {
    assert.deepEqual(launchWith({ default: bad, work: kept }), { default: {}, work: kept }, `profile choices ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, {}, [], true]) {
    assert.deepEqual(launchWith({ default: { bad, ...kept } }), { default: kept }, `stamp ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, 7, "stamp", [null], [[0]]]) {
    assert.deepEqual(launchWith(bad), {}, `every profile's choices ${JSON.stringify(bad)}`);
  }
});

function pinnedSession() {
  const saved = { ...olderSession(), version: SESSION_VERSION };
  const [id] = Object.keys(saved.tabs);
  saved.tabs[id] = { ...saved.tabs[id], pin: { as: "row" } };
  return { saved, id, kept: { [`place:${id}`]: "0mwo1usf5.0001." } };
}

async function saved(rig) {
  await rig.stop.flush();
  await rig.stop.flush();
  return rig.disk().pinChoices;
}

test("a save takes malformed pin choices off the disk and keeps the valid ones", async () => {
  const { saved: session, id, kept } = pinnedSession();
  const cases = [
    [{ default: { broken: true, ...kept } }, { default: kept }],
    [{ default: { [id]: null, ...kept } }, { default: kept }],
    [{ default: { [id]: { h: "nested" }, ...kept } }, { default: kept }],
    [{ default: kept, gone: null }, { default: kept }],
    ...[null, 7, "stamp", [], [null], [[0]]].map((bad) => [bad, {}]),
    ...[null, 7, "stamp", [], [null]].map((bad) => [{ default: bad }, {}]),
  ];
  for (const [bad, clean] of cases) {
    for (const edited of [false, true]) {
      const stored = { ...session, pinChoices: bad };
      const rig = persistenceRig(stored);
      try {
        if (edited) useBrowser.getState().updateSettings({ sidebarWidth: 301 });
        assert.deepEqual(await saved(rig), clean, `${JSON.stringify(bad)}, edited ${edited}`);
        const [first] = rig.writes;
        assert.deepEqual(mergeSession(first.base, first.session, stored).pinChoices, clean, "the first write already repairs it, as a window that closes gets only one");
        if (edited) assert.equal(rig.disk().settings.sidebarWidth, 301);
        const count = rig.writes.length;
        await saved(rig);
        assert.equal(rig.writes.length, count, "a repaired session isn't written again");
      } finally {
        rig.restore();
      }
    }
  }
});

test("numeric pin choices are stamps on disk after the first save", async () => {
  const { saved: session, id } = pinnedSession();
  const rig = persistenceRig({ ...session, pinChoices: { default: { [id]: 1792984216515 } } });
  try {
    assert.equal(typeof (await saved(rig)).default[id], "string");
  } finally {
    rig.restore();
  }
});

test("a repair keeps a choice another window saved meanwhile", async () => {
  const { saved: session, id, kept } = pinnedSession();
  const rig = persistenceRig({ ...session, pinChoices: { default: { broken: true, ...kept } } });
  try {
    rig.edit((disk) => ({ ...disk, pinChoices: { default: { ...disk.pinChoices.default, [id]: "0mwo1usf6.0001." } } }));
    assert.deepEqual(await saved(rig), { default: { ...kept, [id]: "0mwo1usf6.0001." } });
  } finally {
    rig.restore();
  }
});

test("malformed pin choices that arrive in another window's update or a write's reply are taken off the disk", async () => {
  const { saved: session, kept } = pinnedSession();
  const broken = (disk) => ({ ...disk, pinChoices: { default: { broken: true, ...kept } } });
  for (const arrive of [(rig) => rig.peerWrites(broken), (rig) => (rig.edit(broken), useBrowser.getState().updateSettings({ sidebarWidth: 302 }))]) {
    const rig = persistenceRig({ ...session, pinChoices: { default: kept } });
    try {
      await saved(rig);
      arrive(rig);
      assert.deepEqual(await saved(rig), { default: kept });
    } finally {
      rig.restore();
    }
  }
});

test("a Settings window's save takes malformed pin choices off the disk", async () => {
  const { saved: session, kept } = pinnedSession();
  const stored = { ...session, pinChoices: { default: { broken: true, ...kept } } };
  const rig = persistenceRig(stored, () => createUtilitySessionSnapshot(useBrowser.getState(), linuxSessionShape(stored)), "settings");
  try {
    useBrowser.getState().updateSettings({ sidebarWidth: 303 });
    assert.deepEqual(await saved(rig), { default: kept });
    assert.equal(rig.disk().settings.sidebarWidth, 303);
  } finally {
    rig.restore();
  }
});
