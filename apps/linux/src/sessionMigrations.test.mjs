import assert from "node:assert/strict";
import test from "node:test";
import { initialLinuxSession } from "./session.ts";
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

function persistenceRig(stored) {
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  let disk = structuredClone(stored);
  const writes = [];
  const native = {
    ...host(),
    async invoke(method, pair) {
      if (method === "session.read") return disk;
      assert.equal(method, "session.write");
      writes.push(structuredClone(pair));
      disk = mergeSession(pair.base, pair.session, disk);
      return disk;
    },
    onEvent: () => () => {},
    onBeforeClose: () => () => {},
  };
  useBrowser.getState().hydrate(initialLinuxSession(native, stored));
  const stop = startHostPersistence(native, useBrowser, stored);
  return { writes, stop, disk: () => disk, restore() { stop(); globalThis.window = savedWindow; globalThis.document = savedDocument; } };
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

test("a session that only lacks the version stamp launches like a stamped one, and has the stamp after its next save", async () => {
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
  assert.equal(await launchWrites(unstamped), await launchWrites(settled));
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
