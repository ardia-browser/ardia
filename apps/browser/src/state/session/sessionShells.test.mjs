import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, startPersistence, SESSION_VERSION } = await import("./persist.ts");
const { takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const tab = (id, windowId, extra = {}) => ({
  id, windowId, profileId: "default", url: `https://${id}.test/`, title: id, favicon: null, pin: null, muted: false, zoom: 1,
  customTitle: null, customIcon: null, pinnedUrl: null, openerId: null, createdAt: 1, lastActiveAt: 2, page: { kind: "idle" }, ...extra,
});

function webuiTables(version = SESSION_VERSION) {
  const tabs = [tab("tile", "main", { pin: { as: "tile", folder: { id: "f", name: "Read" } } }), tab("a", "main"), tab("left", "main"), tab("right", "main", { page: { kind: "asleep" } }), tab("g", "main")];
  return {
    version,
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } },
    profileOrder: ["default"],
    windows: { main: { id: "main", profileId: "default", kind: "main", tabIds: tabs.map((t) => t.id), activeTabIds: { default: "a" }, frame: null, createdAt: 1 } },
    windowOrder: ["main"],
    focusedWindowId: "main",
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    groups: { grp: { id: "grp", windowId: "main", profileId: "default", name: "Project", icon: null, color: null, tabIds: ["g"] } },
    splits: { sv: { id: "sv", windowId: "main", orientation: "vertical", slots: [{ size: 0.5, tabId: "left" }, { size: 0.5, tabId: "right" }] } },
    closedTabs: [], closedWindows: [],
    settings: { restoreSession: true, autoHideTabs: false },
  };
}

function reset() {
  stub.docs.clear();
  S().hydrate({});
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    flushPersistence();
    await turn();
  }
}

async function launchOn(saved) {
  reset();
  stub.docs.set("session.json", JSON.stringify(saved));
  stub.docs.set("downloads.json", JSON.stringify({ version: 3, downloads: [] }));
  const stop = startPersistence();
  await settle();
  return stop;
}

test("the Mac app loads the WebUI's table session whole, without setting it aside, and saves it back as lists", async () => {
  const stop = await launchOn(webuiTables());
  const s = S();
  assert.deepEqual(s.windows.main.tabIds, ["tile", "a", "left", "right", "g"]);
  assert.deepEqual(s.windows.main.activeTabIds, { default: "a" });
  assert.deepEqual(s.tabs.tile.pin, { as: "tile", folder: { id: "f", name: "Read" } });
  assert.deepEqual(s.groups.grp.tabIds, ["g"]);
  assert.deepEqual(s.splits.sv.slots, [{ size: 0.5, tabId: "left" }, { size: 0.5, tabId: "right" }]);
  assert.deepEqual([...stub.docs.keys()].filter((name) => name.includes("unreadable")), []);
  S().newTab("main", { url: "https://new.test/", background: true });
  await settle();
  stop();
  const written = JSON.parse(stub.docs.get("session.json"));
  for (const rows of ["windows", "tabs", "groups", "splits"]) assert.ok(Array.isArray(written[rows]), rows);
  const ids = written.tabs.map((t) => t.id);
  assert.ok(["tile", "a", "left", "right", "g"].every((id) => ids.includes(id)));
  assert.equal(written.tabs.length, 6);
});

test("an older WebUI table session with legacy pins migrates in the Mac app", () => {
  const older = webuiTables(4);
  for (const t of Object.values(older.tabs)) {
    if (t.pin) Object.assign(t, { pinned: true, tileFolder: t.pin.folder });
    delete t.pin;
  }
  reset();
  stub.docs.set("session.json", JSON.stringify(older));
  const loaded = loadSession();
  assert.deepEqual(loaded.tabs.tile.pin, { as: "tile", folder: { id: "f", name: "Read" } });
  assert.deepEqual(Object.keys(loaded.tabs).sort(), ["a", "g", "left", "right", "tile"]);
  assert.deepEqual(loaded.windows.main.tabIds, ["tile", "a", "left", "right", "g"]);
});

test("telemetry counts a launch on the other shell's table session, and not one on the Mac app's own lists", async () => {
  setConsentPeriod(true, "epoch-session-shells");
  try {
    takeSessionWrites();
    (await launchOn(webuiTables()))();
    assert.equal(takeSessionWrites().session_from_other_shell, 1);
    (await launchOn(webuiTables(10)))();
    assert.equal(S().windows.main.tabIds.length, 5);
    assert.equal(takeSessionWrites().session_from_other_shell, 1, "a table session that migrates still counts");
    const lists = webuiTables();
    for (const rows of ["windows", "tabs", "groups", "splits"]) lists[rows] = Object.values(lists[rows]);
    (await launchOn(lists))();
    assert.equal(takeSessionWrites().session_from_other_shell, 0);
  } finally {
    setConsentPeriod(false, null);
  }
});

for (const version of [SESSION_VERSION, 10, 4]) test(`a v${version} table session whose only damage is a row filed under another key is copied aside before the Mac app rewrites it`, async () => {
  const saved = webuiTables(version);
  const { a, ...rest } = saved.tabs;
  saved.tabs = { ...rest, misfiled: a };
  const stop = await launchOn(saved);
  assert.equal(S().tabs.a.windowId, "main");
  S().newTab("main", { url: "https://new.test/", background: true });
  await settle();
  stop();
  const aside = [...stub.docs.keys()].filter((name) => /^session-unreadable-\d+-\d+\.json$/.test(name));
  assert.equal(aside.length, 1);
  assert.ok(Object.hasOwn(JSON.parse(stub.docs.get(aside[0])).tabs, "misfiled"));
  assert.ok(Array.isArray(JSON.parse(stub.docs.get("session.json")).tabs));
});

test("the Mac app saves a WebUI table session back as lists at launch, with no edit", async () => {
  const stop = await launchOn(webuiTables());
  await settle();
  stop();
  const written = JSON.parse(stub.docs.get("session.json"));
  for (const rows of ["windows", "tabs", "groups", "splits"]) assert.ok(Array.isArray(written[rows]), rows);
  assert.deepEqual(written.tabs.map((t) => t.id).sort(), ["a", "g", "left", "right", "tile"]);
  assert.deepEqual([...stub.docs.keys()].filter((name) => name.includes("unreadable")), []);
});
