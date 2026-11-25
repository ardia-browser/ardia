import assert from "node:assert/strict";
import { test } from "node:test";

const realNow = Date.now;
const startedAt = realNow();
const midday = new Date(2026, 4, 6, 12).getTime();
Date.now = () => midday + (realNow() - startedAt);
const realMonotonic = performance.now.bind(performance);
let monotonicSkew = 0;
performance.now = () => realMonotonic() + monotonicSkew;

const setTimeoutHoldingExit = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = setTimeoutHoldingExit(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, resumePersistence, sessionSaved, sessionWritesBlocked, startPersistence, SESSION_VERSION } = await import("./persist.ts");
const { finishQuitSaves } = await import("../app/quit.ts");
const { BACKUP_EVERY_MS, BACKUP_RETRY_MS, backupJson, DAILY_BACKUP, MIGRATION_BACKUP, rollingBackups, sessionBackups } = await import("./sessionSafety.ts");
const { parsePinBackups, PINS_BACKUP_DOCUMENT } = await import("./pinGuard.ts");
const { noteSessionBackup: noteBackupForTest, takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const noonOf = (day) => new Date(`${day}T12:00:00`).getTime();
const putBackup = (day, json, offset = 0) => stub.docs.set(`${DAILY_BACKUP}${noonOf(day) + offset}.json`, backupJson(noonOf(day) + offset, json));
const backupAtOf = (name) => JSON.parse(stub.docs.get(name)).backupAt;
const backupsOf = (prefix) =>
  [...stub.docs.keys()]
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => backupAtOf(b) - backupAtOf(a) || Number(b.slice(prefix.length, -5)) - Number(a.slice(prefix.length, -5)));
const newest = (prefix) => JSON.parse(stub.docs.get(backupsOf(prefix)[0]));
async function settle() {
  flushPersistence();
  for (let i = 0; i < 4; i++) {
    await turn();
    flushPersistence();
  }
}
const DAY_MS = 86_400_000;

function clean() {
  stub.docs.clear();
  stub.stagedDocs.clear();
  stub.unreadableDocs.clear();
  stub.copiedDocs.length = 0;
  stub.refusedCopies.on = false;
  stub.refusedCopies.of.clear();
  stub.refusedSaves.on = false;
  stub.refusedSyncs.on = false;
  stub.linkedButUnsynced.on = false;
  stub.takenNames.clear();
  stub.heldCopies.on = false;
  stub.heldCopies.queue.length = 0;
  stub.asyncExists.on = false;
  S().hydrate({});
}

function realSession(urls = ["https://kept.example/one", "https://kept.example/two"], { pin = null } = {}) {
  clean();
  const stop = startPersistence();
  const w = S().createWindow({ url: urls[0] });
  for (const url of urls.slice(1)) S().newTab(w, { url, background: true });
  if (pin) S().pinTabs([S().newTab(w, { url: pin, background: true })], true);
  flushPersistence();
  stop();
  const json = stub.docs.get("session.json");
  clean();
  return json;
}

const asideCopies = () => [...stub.docs.keys(), ...stub.unreadableDocs].filter((name) => /^session-unreadable-\d+-\d+\.json$/.test(name));
const tabUrls = () => Object.values(S().tabs).map((t) => t.url).sort();
const savedUrls = () => JSON.parse(stub.docs.get("session.json")).tabs.map((t) => t.url).sort();

const DAMAGED = {
  empty: "",
  blank: "  \n",
  truncated: null,
  "not an object": "[1,2,3]",
  "bad version": JSON.stringify({ version: "eleven", windows: [] }),
  newer: JSON.stringify({ version: SESSION_VERSION + 1, windows: [], tabs: [] }),
};

for (const [kind, damaged] of Object.entries(DAMAGED)) {
  test(`a session.json that is ${kind} is kept aside, never written over, and the newest backup comes back`, async () => {
    const good = realSession();
    const bad = damaged ?? good.slice(0, Math.floor(good.length / 2));
    putBackup("2026-01-05", good, 1);
    stub.docs.set("session.json", bad);
    const stop = startPersistence();
    assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"], "the backup's tabs are back");
    await settle();
    stop();
    const [copy] = asideCopies();
    assert.ok(copy, "the damaged file was copied aside");
    assert.equal(stub.docs.get(copy), bad, "byte for byte");
    assert.deepEqual(savedUrls(), ["https://kept.example/one", "https://kept.example/two"], "the restored session replaced it after the copy landed");
  });
}

test("a session.json that exists but can't be read is copied aside by the store before anything is written", async () => {
  const good = realSession();
  putBackup("2026-01-05", good, 1);
  stub.unreadableDocs.add("session.json");
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.equal(stub.copiedDocs[0][0], "session.json");
  assert.ok(stub.unreadableDocs.has(stub.copiedDocs[0][1]), "the unread bytes went to the copy");
  assert.deepEqual(savedUrls(), ["https://kept.example/one", "https://kept.example/two"]);
});

test("an unreadable session.json is never written over while the copy keeps failing, and is once it lands", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.refusedCopies.on = true;
  const stop = startPersistence();
  S().createWindow({ url: "https://new.example/" });
  await settle();
  await sessionSaved();
  assert.ok(stub.unreadableDocs.has("session.json"), "still the unread file");
  assert.ok(!stub.docs.has("session.json"), "nothing written over it");
  stub.refusedCopies.on = false;
  const now = Date.now;
  Date.now = () => now() + 120_000;
  monotonicSkew += 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.ok(stub.copiedDocs.length >= 2, "the copy was tried again");
  assert.equal(asideCopies().length, 1);
  assert.deepEqual(savedUrls(), ["https://new.example/"]);
});

test("with no backup, a damaged session.json is kept aside and Ardia starts fresh", async () => {
  clean();
  stub.docs.set("session.json", "{\"version\":11,\"tabs\":[");
  const stop = startPersistence();
  assert.deepEqual(S().windowOrder, []);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), "{\"version\":11,\"tabs\":[");
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
});

test("when the store answers only later that an unread session.json exists, nothing is written until it is copied", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.asyncExists.on = true;
  const stop = startPersistence();
  S().createWindow({ url: "https://later.example/" });
  flushPersistence();
  assert.ok(!stub.docs.has("session.json"), "held while the answer is pending");
  await settle();
  stop();
  assert.equal(stub.copiedDocs.length, 1);
  assert.deepEqual(savedUrls(), ["https://later.example/"]);
});

test("a missing session.json is a first launch: nothing is copied and nothing is restored", async () => {
  const good = realSession();
  putBackup("2026-01-05", good, 1);
  const stop = startPersistence();
  assert.deepEqual(S().windowOrder, []);
  S().createWindow({ url: "https://first.example/" });
  flushPersistence();
  stop();
  assert.deepEqual(stub.copiedDocs, []);
  assert.deepEqual(savedUrls(), ["https://first.example/"]);
});

test("a downgrade keeps the newer session.json aside and restores an older-version backup through the migrations", async () => {
  const good = JSON.parse(realSession(["https://before-upgrade.example/"]));
  const v9 = { ...good, version: 9 };
  putBackup("2026-01-05", JSON.stringify(v9), 1);
  const newer = JSON.stringify({ ...good, version: SESSION_VERSION + 3 });
  stub.docs.set("session.json", newer);
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://before-upgrade.example/"]);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), newer);
});

test("a damaged downloads.json is kept aside, by the store or from its text, and not written over until a copy lands", async () => {
  realSession();
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", "{\"version\":3,\"downloads\":[{");
  stub.refusedCopies.on = true;
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 });
  await settle();
  assert.equal(stub.docs.get("downloads.json"), "{\"version\":3,\"downloads\":[{");
  stub.refusedCopies.on = false;
  stub.refusedSaves.on = false;
  const now = Date.now;
  Date.now = () => now() + 120_000;
  monotonicSkew += 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.ok(stub.docs.has([...stub.docs.keys()].find((name) => /^downloads-unreadable-/.test(name))));
  assert.equal(JSON.parse(stub.docs.get("downloads.json")).downloads[0].filename, "a.zip");
});

test("pins restored from a backup are still guarded: dropping one first lands it in pins-backup.json", async () => {
  const good = realSession(["https://loose.example/"], { pin: "https://pin.example/" });
  putBackup("2026-01-05", good, 1);
  stub.docs.set("session.json", "garbage");
  const stop = startPersistence();
  await settle();
  const pinned = Object.values(S().tabs).find((t) => t.pin);
  assert.ok(pinned, "the pin came back from the backup");
  S().pinTabs([pinned.id], false);
  await settle();
  stop();
  const [entry] = parsePinBackups(stub.docs.get(PINS_BACKUP_DOCUMENT));
  assert.deepEqual(Object.values(entry.pins)[0].tabs.map((t) => t.url), ["https://pin.example/"]);
  assert.equal(stub.docs.get(asideCopies()[0]), "garbage");
});

test("a current-version session.json whose core lists aren't lists is kept aside and the backup restored, not hydrated empty and saved over", async () => {
  const good = realSession();
  putBackup("2026-01-05", good, 1);
  const bad = JSON.stringify({ ...JSON.parse(good), windows: "x", tabs: "y" });
  stub.docs.set("session.json", bad);
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), bad);
});

test("an order entry naming an Object property (windowOrder [\"constructor\"]) is dropped while reading, so that backup restores, passes as today's, and loadSession agrees", async () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"]));
  const tampered = { ...newest, windowOrder: ["constructor"], profileOrder: ["toString"], focusedWindowId: "__proto__" };
  putBackup("2026-01-03", older, 1);
  putBackup("2026-01-04", JSON.stringify(tampered), 1);
  stub.docs.set("session.json", "{");
  assert.deepEqual(Object.values(loadSession().tabs).map((t) => t.url), ["https://newest.example/"]);
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://newest.example/"]);
  const { wholeBackup } = await import("./launchSession.ts");
  assert.equal(wholeBackup(tampered), true);
});

test("when the store can't say whether an unread session.json exists, nothing is written over it", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.refusedCopies.on = true;
  const documents = stub.shellNativeModules.ArdiaDocuments;
  const exists = documents.documentExists;
  documents.documentExists = () => {
    throw new Error("probe failed");
  };
  try {
    const stop = startPersistence();
    S().createWindow({ url: "https://new.example/" });
    await settle();
    stop();
  } finally {
    documents.documentExists = exists;
  }
  assert.ok(stub.unreadableDocs.has("session.json"));
  assert.ok(!stub.docs.has("session.json"), "held, not written over");
});

test("a damaged session with no backup keeps the download history", async () => {
  realSession();
  stub.docs.set("session.json", "{");
  stub.docs.set("downloads.json", JSON.stringify({ version: 3, downloads: [{ id: "old", url: "https://files.example/old.zip", filename: "old.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 }] }));
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/new.zip", filename: "new.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 1 });
  await settle();
  stop();
  assert.deepEqual(JSON.parse(stub.docs.get("downloads.json")).downloads.map((d) => d.filename).sort(), ["new.zip", "old.zip"]);
});

test("when the store answers only later that an unread session.json exists, the newest backup still comes back", async () => {
  const good = realSession();
  putBackup("2026-01-05", good, 1);
  stub.unreadableDocs.add("session.json");
  stub.asyncExists.on = true;
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.deepEqual(savedUrls(), ["https://kept.example/one", "https://kept.example/two"]);
});

test("quitting waits for a downloads.json copy still landing, then saves the pending download", async () => {
  realSession();
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", "{\"version\":3,\"downloads\":[{");
  stub.unreadableDocs.add("downloads.json");
  stub.heldCopies.on = true;
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 });
  flushPersistence({ final: true });
  const quitting = finishQuitSaves(5_000);
  await turn();
  assert.ok(stub.unreadableDocs.has("downloads.json"), "not written while the copy is landing");
  stub.heldCopies.on = false;
  for (const land of stub.heldCopies.queue.splice(0)) land();
  await quitting;
  stop();
  resumePersistence();
  assert.equal(JSON.parse(stub.docs.get("downloads.json")).downloads[0].filename, "a.zip");
});

test("received tabs wait while the session can't be written, so sync doesn't count them delivered", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.heldCopies.on = true;
  const stop = startPersistence();
  assert.equal(sessionWritesBlocked(), true);
  stub.heldCopies.on = false;
  for (const land of stub.heldCopies.queue.splice(0)) land();
  await settle();
  stop();
  assert.equal(sessionWritesBlocked(), false);
});

test("every retry of a failed copy goes to the same file, so failed tries don't pile up", async () => {
  realSession();
  stub.docs.set("session.json", "{");
  stub.refusedCopies.on = true;
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  const now = Date.now;
  let skew = 0;
  Date.now = () => now() + skew;
  try {
    for (let i = 0; i < 4; i++) {
      skew += 120_000;
      monotonicSkew += 120_000;
      await settle();
    }
  } finally {
    Date.now = now;
  }
  stop();
  assert.ok(stub.copiedDocs.length >= 3);
  assert.equal(new Set(stub.copiedDocs.map(([, to]) => to)).size, 1);
});

test("a backup that throws while being prepared (session restore off, a numeric pinned URL) is skipped for an older one", async () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"], { pin: "https://pin.example/" }));
  newest.settings = { ...newest.settings, restoreSession: false };
  newest.tabs = newest.tabs.map((t) => (t.pin ? { ...t, pinnedUrl: 42 } : t));
  putBackup("2026-01-03", older, 1);
  putBackup("2026-01-04", JSON.stringify(newest), 1);
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://older.example/"]);
});

test("a download row with a numeric profile doesn't stop the launch; the good rows load", async () => {
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", JSON.stringify({ version: 3, downloads: [{ id: "bad", state: "complete", profile: 5 }, { id: "good", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 }] }));
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(S().downloads.map((d) => d.filename), ["a.zip"]);
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
});

test("a version stamp alone is not a session: it is kept aside and the backup restored", async () => {
  const good = realSession();
  putBackup("2026-01-05", good, 1);
  const stamp = JSON.stringify({ version: SESSION_VERSION, hello: "world" });
  stub.docs.set("session.json", stamp);
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), stamp);
});

test("a session whose rows the reader had to drop loads what is whole and keeps the original aside first", async () => {
  const good = JSON.parse(realSession());
  const damaged = JSON.stringify({ ...good, tabs: [...good.tabs, { id: "broken" }, 7] });
  stub.docs.set("session.json", damaged);
  setConsentPeriod(true, "epoch-session-rows");
  takeSessionWrites();
  try {
    const stop = startPersistence();
    assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
    await settle();
    stop();
    assert.equal(takeSessionWrites().session_set_aside_rows, 1);
  } finally {
    setConsentPeriod(false, null);
  }
  assert.equal(stub.docs.get(asideCopies()[0]), damaged);
  assert.equal(JSON.parse(stub.docs.get("session.json")).tabs.length, 2);
});

test("quitting during a copy's retry wait tries the copy again at once and saves the pending download", async () => {
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", "{\"version\":3,\"downloads\":[{");
  stub.refusedCopies.on = true;
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  await settle();
  stub.refusedCopies.on = false;
  stub.refusedSaves.on = false;
  S().upsertDownload({ id: "d1", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 });
  flushPersistence({ final: true });
  await finishQuitSaves(3_000);
  stop();
  resumePersistence();
  assert.equal(JSON.parse(stub.docs.get("downloads.json")).downloads[0].filename, "a.zip");
});

test("a write gate runs one copy at a time and takes its success whenever it comes", async () => {
  const { writeGate } = await import("./sessionSafety.ts");
  let runs = 0;
  let finish;
  const gate = writeGate(() => (runs++, new Promise((resolve) => (finish = resolve))), () => {});
  for (let i = 0; i < 5; i++) assert.equal(gate.check().hold, true);
  gate.tryNow();
  assert.equal(runs, 1);
  finish();
  await turn();
  assert.equal(gate.open(), true);
  assert.equal(gate.check().hold, false);
});

test("a pin that hydrating drops (its profile is gone) makes the launch keep the original aside before the first save", async () => {
  const good = JSON.parse(realSession(["https://loose.example/"], { pin: "https://pin.example/" }));
  const orphaned = JSON.stringify({ ...good, tabs: good.tabs.map((t) => (t.pin ? { ...t, profileId: "gone-profile" } : t)) });
  stub.docs.set("session.json", orphaned);
  const stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), orphaned, "the dropped pin is still on disk, beside");
});

test("an intact older backup wins over a newer one whose rows the reader had to drop", async () => {
  const older = realSession(["https://older.example/"], { pin: "https://pin.example/" });
  const newest = JSON.parse(realSession(["https://newest.example/"]));
  putBackup("2026-01-03", older, 1);
  putBackup("2026-01-04", JSON.stringify({ ...newest, tabs: [...newest.tabs, { id: "half" }] }), 1);
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  stop();
  assert.ok(tabUrls().includes("https://older.example/"));
  assert.ok(tabUrls().includes("https://pin.example/"));
});

test("a damaged backup is the fallback when it is the only one, with what of it is whole", async () => {
  const newest = JSON.parse(realSession(["https://only.example/"]));
  putBackup("2026-01-04", JSON.stringify({ ...newest, tabs: [...newest.tabs, { id: "half" }] }), 1);
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://only.example/"]);
});

test("download rows the reader rejects keep downloads.json aside before it is rewritten, and the good rows load", async () => {
  stub.docs.set("session.json", realSession());
  const original = JSON.stringify({ version: 3, downloads: [{ id: "bad", state: "complete", profile: 5 }, { id: "good", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 }] });
  stub.docs.set("downloads.json", original);
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/b.zip", filename: "b.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 1 });
  await settle();
  stop();
  const aside = [...stub.docs.keys()].find((name) => /^downloads-unreadable-/.test(name));
  assert.equal(stub.docs.get(aside), original);
  assert.deepEqual(JSON.parse(stub.docs.get("downloads.json")).downloads.map((d) => d.filename).sort(), ["a.zip", "b.zip"]);
});

test("loadSession picks the same session launch does, skipping a backup that throws while it is prepared", () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"], { pin: "https://pin.example/" }));
  newest.settings = { ...newest.settings, restoreSession: false };
  newest.tabs = newest.tabs.map((t) => (t.pin ? { ...t, pinnedUrl: 42 } : t));
  putBackup("2026-01-03", older, 1);
  putBackup("2026-01-04", JSON.stringify(newest), 1);
  stub.docs.set("session.json", "{");
  const data = loadSession();
  assert.deepEqual(Object.values(data.tabs).map((t) => t.url), ["https://older.example/"]);
});

test("parked pins the reader has to discard keep session.json aside before the first save", async () => {
  const good = JSON.parse(realSession(["https://a.example/"]));
  const profileId = Object.keys(good.profiles)[0];
  const damaged = JSON.stringify({ ...good, parkedPins: { [profileId]: { tabs: [{ id: "p", url: "https://parked.example/", profileId }], groups: "broken" } } });
  stub.docs.set("session.json", damaged);
  const stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), damaged);
});

test("a parked pin group that isn't a group with an id is a damaged record, not a restorable backup", async () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"]));
  const profileId = Object.keys(newest.profiles)[0];
  const broken = { ...newest, parkedPins: { [profileId]: { tabs: [], groups: [null] } } };
  const { wholeBackup } = await import("./launchSession.ts");
  assert.equal(wholeBackup(broken), false);
  putBackup("2026-01-03", older, 1);
  putBackup("2026-01-04", JSON.stringify(broken), 1);
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  assert.doesNotThrow(() => S().createWindow({ profileId }));
  stop();
  assert.ok(tabUrls().includes("https://older.example/"));
});

for (const key of ["cleanedTabs", "closedGroups", "deletedGroups", "closedTabs", "closedWindows"]) {
  test(`a ${key} that is there but isn't a list keeps session.json aside before the first save, and the open tabs still load`, async () => {
    const good = JSON.parse(realSession());
    const damaged = JSON.stringify({ ...good, [key]: { kept: { id: "x" } } });
    stub.docs.set("session.json", damaged);
    const stop = startPersistence();
    assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
    S().updateSettings({ appearance: "light" });
    await settle();
    stop();
    assert.equal(stub.docs.get(asideCopies()[0]), damaged);
  });
}

const backups = (rules = {}) => rollingBackups({ whole: () => true, recovering: () => false, written: () => {}, ...rules });
const session = (n) => `{"version":${SESSION_VERSION},"windows":[],"tabs":[],"n":${n}}`;

test("restore picks the newest backup by when it was made, skipping damaged, newer and unknown-shaped ones, migration snapshots included", () => {
  const older = realSession(["https://older.example/"]);
  const newer = realSession(["https://newer.example/"]);
  putBackup("2026-01-03", older);
  stub.docs.set(`${MIGRATION_BACKUP}${noonOf("2026-01-04")}.json`, backupJson(noonOf("2026-01-04"), newer));
  putBackup("2026-01-05", JSON.stringify({ version: SESSION_VERSION + 1, tabs: [] }));
  stub.docs.set(`${DAILY_BACKUP}${noonOf("2026-01-06")}.json`, `{"backupAt":${noonOf("2026-01-06")},"session":{"tabs":`);
  putBackup("2026-01-07", "[]");
  stub.docs.set(`${DAILY_BACKUP}notastamp.json`, backupJson(noonOf("2026-01-08"), older));
  stub.docs.set("session.json", "nonsense");
  S().hydrate(loadSession());
  assert.deepEqual(tabUrls(), ["https://newer.example/"]);
  const [picked] = sessionBackups((doc) => doc, SESSION_VERSION, {}, noonOf("2026-01-10"));
  assert.equal(picked.at, noonOf("2026-01-04"));
  assert.equal(picked.ageDays, 6);
});

test("the first save writes a backup only when none was made in the last 24 hours, each under its own new name", async () => {
  clean();
  const start = noonOf("2026-05-03");
  const rolling = backups();
  rolling.afterSave(session(0), start);
  await turn();
  rolling.afterSave(session(1), start + 3_600_000);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 1);
  assert.equal(newest(DAILY_BACKUP).session.n, 0);
  assert.equal(newest(DAILY_BACKUP).backupAt, start);
  const relaunch = backups();
  relaunch.afterSave(session(2), start + 7_200_000);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 1, "a relaunch inside the 24 hours writes none");
  relaunch.afterSave(session(3), start + BACKUP_EVERY_MS + 1);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 2);
  assert.equal(JSON.parse(stub.docs.get(backupsOf(DAILY_BACKUP).find((name) => backupAtOf(name) === start))).session.n, 0, "the earlier file is never rewritten");
});

test("seven daily backups are kept, the oldest go, and nothing is pruned while recovering", async () => {
  clean();
  const start = noonOf("2026-05-03");
  for (let day = 0; day < 9; day++) {
    backups().afterSave(session(day), start + day * BACKUP_EVERY_MS);
    await turn();
  }
  assert.equal(backupsOf(DAILY_BACKUP).length, 7);
  assert.deepEqual(backupsOf(DAILY_BACKUP).map((name) => JSON.parse(stub.docs.get(name)).session.n), [8, 7, 6, 5, 4, 3, 2]);
  backups({ recovering: () => true }).afterSave(session(9), start + 9 * BACKUP_EVERY_MS);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 8, "a recovering launch prunes nothing");
});

test("pruning never removes the newest backup that loads whole, even when newer ones don't", async () => {
  clean();
  const start = noonOf("2026-05-03");
  putBackup("2026-05-02", session(1));
  for (let i = 1; i <= 8; i++) putBackup("2026-05-02", session(100 + i), i * 3_600_000);
  backups({ whole: (value) => value?.n === 1 }).afterSave(session(2), start);
  await turn();
  assert.ok(stub.docs.has(`${DAILY_BACKUP}${noonOf("2026-05-02")}.json`), "the newest whole backup survives though it is the oldest");
  assert.equal(newest(DAILY_BACKUP).session.n, 2, "the one just written survives");
  assert.equal(backupsOf(DAILY_BACKUP).length, 8);
});

test("a clock that jumped back never replaces a backup: one stamped ahead stays, and a new one is written beside it", async () => {
  clean();
  const now = noonOf("2026-05-03");
  const ahead = now + 7 * BACKUP_EVERY_MS;
  stub.docs.set(`${DAILY_BACKUP}${ahead}.json`, backupJson(ahead, session(1)));
  backups().afterSave(session(2), now);
  await turn();
  assert.equal(JSON.parse(stub.docs.get(`${DAILY_BACKUP}${ahead}.json`)).session.n, 1);
  assert.equal(backupsOf(DAILY_BACKUP).length, 2);
});

test("a failed backup write is tried again a few minutes later, not on every save", async () => {
  clean();
  const at = noonOf("2026-05-03");
  const rolling = backups();
  stub.refusedSaves.on = true;
  try {
    rolling.afterSave(session(0), at);
    await turn();
  } finally {
    stub.refusedSaves.on = false;
  }
  stub.stagedDocs.clear();
  rolling.afterSave(session(1), at + 1000);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 0);
  const now = Date.now;
  Date.now = () => now() + BACKUP_RETRY_MS + 1;
  monotonicSkew += BACKUP_RETRY_MS + 1;
  try {
    rolling.afterSave(session(2), at + 2000);
    await turn();
  } finally {
    Date.now = now;
  }
  assert.equal(newest(DAILY_BACKUP).session.n, 2);
});

test("the first save of a launch writes a backup of the session it saved", async () => {
  clean();
  const stop = startPersistence();
  S().createWindow({ url: "https://today.example/" });
  flushPersistence();
  await turn();
  stop();
  assert.deepEqual(newest(DAILY_BACKUP).session.tabs.map((t) => t.url), ["https://today.example/"]);
});

test("a session.json that still needs migrating is snapshotted to its own file first, and daily backups are never touched", async () => {
  const good = JSON.parse(realSession(["https://old-version.example/"]));
  const sameDay = backupJson(Date.now() - 60_000, JSON.stringify(good));
  stub.docs.set(`${DAILY_BACKUP}${Date.now() - 60_000}.json`, sameDay);
  const old = JSON.stringify({ ...good, version: 9 });
  stub.docs.set("session.json", old);
  const stop = startPersistence();
  S().updateTab(Object.keys(S().tabs)[0], { title: "touched" });
  flushPersistence();
  assert.equal(stub.docs.get("session.json"), old, "the migrated session waits for the snapshot");
  await settle();
  stop();
  assert.equal(newest(MIGRATION_BACKUP).session.version, 9);
  assert.equal(stub.docs.get(backupsOf(DAILY_BACKUP).at(-1)), sameDay, "the same-day daily backup is untouched");
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
});

test("when the pre-migration snapshot can't be saved, the migrated session isn't written over the old one, and it is retried on its own", async () => {
  const good = JSON.parse(realSession(["https://old-version.example/"]));
  const old = JSON.stringify({ ...good, version: 9 });
  stub.docs.set("session.json", old);
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  await settle();
  assert.equal(sessionWritesBlocked(), true);
  S().updateTab(Object.keys(S().tabs)[0], { title: "touched" });
  await settle();
  assert.equal(stub.docs.get("session.json"), old);
  stub.refusedSaves.on = false;
  stub.stagedDocs.clear();
  const now = Date.now;
  Date.now = () => now() + 120_000;
  monotonicSkew += 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.equal(sessionWritesBlocked(), false);
  assert.equal(newest(MIGRATION_BACKUP).session.version, 9);
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
});

test("only the last three migration snapshots are kept", async () => {
  clean();
  const start = noonOf("2026-05-03");
  for (let i = 0; i < 5; i++) await backups().beforeMigration(session(i), start + i * 1000);
  assert.deepEqual(backupsOf(MIGRATION_BACKUP).map((name) => JSON.parse(stub.docs.get(name)).session.n), [4, 3, 2]);
});

test("restoring yesterday's intact backup leaves today's partial one on disk", async () => {
  const yesterday = realSession(["https://yesterday.example/"]);
  const today = JSON.parse(realSession(["https://today.example/"], { pin: "https://only-here.example/" }));
  const partial = backupJson(Date.now() - 60_000, JSON.stringify({ ...today, tabs: today.tabs.map((t) => (t.pin ? { ...t, profileId: "gone-profile" } : t)) }));
  stub.docs.set(`${DAILY_BACKUP}${Date.now() - BACKUP_EVERY_MS - 60_000}.json`, backupJson(Date.now() - BACKUP_EVERY_MS - 60_000, yesterday));
  stub.docs.set(`${DAILY_BACKUP}${Date.now() - 60_000}.json`, partial);
  for (let i = 2; i < 9; i++) stub.docs.set(`${DAILY_BACKUP}${Date.now() - i * BACKUP_EVERY_MS}.json`, backupJson(Date.now() - i * BACKUP_EVERY_MS, yesterday));
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://yesterday.example/"]);
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.ok([...stub.docs.values()].some((text) => text === partial), "today's partial backup, the only file with that pin, is still there");
});

test("a window whose tabs point at it but whose tab list is empty counts as damage: kept aside, not saved over", async () => {
  const good = JSON.parse(realSession(["https://a.example/", "https://b.example/"]));
  const emptied = JSON.stringify({ ...good, windows: good.windows.map((w) => ({ ...w, tabIds: [] })) });
  stub.docs.set("session.json", emptied);
  const stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), emptied);
});

test("a damaged session.json stays put while the store can't copy its bytes, even when its text could be read", async () => {
  realSession();
  stub.docs.set("session.json", "\uFEFF{\"version\":11,\"tabs\":[");
  stub.refusedCopies.on = true;
  const stop = startPersistence();
  S().createWindow({ url: "https://new.example/" });
  await settle();
  stop();
  assert.equal(stub.docs.get("session.json"), "\uFEFF{\"version\":11,\"tabs\":[");
  assert.equal(asideCopies().length, 0, "no copy from the decoded text");
});

test("a backup started while sharing was off isn't counted when sharing turns on before it lands", async () => {
  clean();
  setConsentPeriod(false, null);
  takeSessionWrites();
  stub.heldSaves.on = true;
  try {
    backups({ written: noteBackupForTest }).afterSave(session(1), noonOf("2026-05-03"));
    setConsentPeriod(true, "epoch-backup-consent");
    for (const land of stub.heldSaves.queue.splice(0)) land();
    await turn();
    assert.equal(takeSessionWrites().session_backups, 0);
  } finally {
    stub.heldSaves.on = false;
    stub.heldSaves.queue.length = 0;
    setConsentPeriod(false, null);
  }
});

test("telemetry counts the set-aside by reason and whether a backup came back, without content", async () => {
  const good = realSession();
  setConsentPeriod(true, "epoch-session-safety");
  takeSessionWrites();
  try {
    stub.docs.set(`${DAILY_BACKUP}${Date.now() - 2 * BACKUP_EVERY_MS}.json`, backupJson(Date.now() - 2 * BACKUP_EVERY_MS, good));
    stub.docs.set("session.json", JSON.stringify({ version: SESSION_VERSION + 1 }));
    stub.docs.set("downloads.json", "");
    const stop = startPersistence();
    await settle();
    stop();
    const counts = takeSessionWrites();
    assert.equal(counts.session_set_aside_newer, 1);
    assert.equal(counts.session_set_aside_invalid, 0);
    assert.equal(counts.session_restored_from_backup, 1);
    assert.equal(counts.session_restored_backup_days_max, 2);
    assert.equal(counts.downloads_set_aside, 1);
  } finally {
    setConsentPeriod(false, null);
  }
});

test("a group whose only tab is missing is damage hydration would drop: the file is kept aside, and such a backup ranks after an intact one", async () => {
  const good = JSON.parse(realSession(["https://a.example/"]));
  const w = good.windows[0];
  const withGroup = { ...good, groups: [{ id: "g-lost", windowId: w.id, profileId: w.profileId, name: "Lost", tabIds: ["missing-tab"], icon: null, color: null }] };
  stub.docs.set("session.json", JSON.stringify(withGroup));
  let stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), JSON.stringify(withGroup));
  const older = realSession(["https://older.example/"]);
  const newer = JSON.parse(realSession(["https://newer.example/"]));
  putBackup("2026-01-03", older);
  putBackup("2026-01-04", JSON.stringify({ ...newer, groups: withGroup.groups.map((g) => ({ ...g, windowId: newer.windows[0].id })) }));
  stub.docs.set("session.json", "{");
  stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://older.example/"]);
});

test("after a backup made with the clock 30 days ahead, a corrected clock still writes backups, and restore prefers the correctly dated one", async () => {
  clean();
  const now = noonOf("2026-05-03");
  const rolling = backups();
  rolling.afterSave(session(1), now + 30 * BACKUP_EVERY_MS);
  await turn();
  rolling.afterSave(session(2), now);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 2, "the corrected clock wrote its own backup");
  const ordered = sessionBackups((doc) => doc, SESSION_VERSION, {}, now);
  assert.equal(ordered[0].value.n, 2, "the correctly dated backup comes first");
});

test("snapshots made in the same millisecond get rising names that never reuse a pruned one, and restore orders them newest first", async () => {
  clean();
  const at = noonOf("2026-05-03");
  const names = [];
  for (let i = 1; i <= 5; i++) {
    await backups().beforeMigration(session(i), at);
    names.push(...backupsOf(MIGRATION_BACKUP).filter((name) => !names.includes(name)));
  }
  assert.equal(new Set(names).size, 5, "five distinct names");
  assert.deepEqual(backupsOf(MIGRATION_BACKUP).map((name) => JSON.parse(stub.docs.get(name)).session.n), [5, 4, 3]);
  assert.deepEqual(sessionBackups((doc) => doc, SESSION_VERSION, {}, at).map((b) => b.value.n), [5, 4, 3]);
});

test("a backup that is only staged, not on disk, doesn't count: a fresh one is written", async () => {
  clean();
  const at = noonOf("2026-05-03");
  stub.stagedDocs.set(`${DAILY_BACKUP}1.json`, backupJson(at - 60_000, session(1)));
  backups().afterSave(session(2), at);
  await turn();
  assert.equal(newest(DAILY_BACKUP).session.n, 2);
});

test("a failed pre-migration snapshot is retried under the one name it reserved", async () => {
  clean();
  const at = noonOf("2026-05-03");
  const rolling = backups();
  stub.refusedSaves.on = true;
  await rolling.beforeMigration(session(1), at).catch(() => {});
  await rolling.beforeMigration(session(1), at).catch(() => {});
  stub.refusedSaves.on = false;
  await rolling.beforeMigration(session(1), at);
  await rolling.beforeMigration(session(1), at);
  assert.equal(backupsOf(MIGRATION_BACKUP).length, 1);
});

test("a group that keeps one tab but loses another reference, or a split that loses a pane, is damage too", async () => {
  const good = JSON.parse(realSession(["https://a.example/", "https://b.example/"]));
  const w = good.windows[0];
  const [one] = good.tabs;
  const variants = [
    { groups: [{ id: "g", windowId: w.id, profileId: w.profileId, name: "G", tabIds: [one.id, "missing"], icon: null, color: null }] },
    { splits: [{ id: "v", windowId: w.id, orientation: "horizontal", slots: [{ size: 0.5, tabId: one.id }, { size: 0.5, tabId: "missing" }] }] },
  ];
  const { wholeBackup } = await import("./launchSession.ts");
  for (const extra of variants) {
    const damaged = JSON.stringify({ ...good, ...extra });
    assert.equal(wholeBackup(JSON.parse(damaged)), false, JSON.stringify(Object.keys(extra)));
    clean();
    stub.docs.set("session.json", damaged);
    const stop = startPersistence();
    S().updateSettings({ appearance: "light" });
    await settle();
    stop();
    assert.equal(stub.docs.get(asideCopies()[0]), damaged);
  }
});

test("a reserved snapshot name another writer took moves on to the next number instead of holding saves forever", async () => {
  clean();
  const at = noonOf("2026-05-03");
  const rolling = backups();
  stub.takenNames.add(`${MIGRATION_BACKUP}1.json`);
  try {
    await rolling.beforeMigration(session(1), at);
  } finally {
    stub.takenNames.clear();
  }
  assert.deepEqual(backupsOf(MIGRATION_BACKUP), [`${MIGRATION_BACKUP}2.json`]);
});

test("a failed backup made with the clock 30 days ahead is retried after the backoff, not 30 days later", async () => {
  clean();
  const now = noonOf("2026-05-03");
  const rolling = backups();
  stub.refusedSaves.on = true;
  try {
    rolling.afterSave(session(1), now + 30 * BACKUP_EVERY_MS);
    await turn();
  } finally {
    stub.refusedSaves.on = false;
  }
  monotonicSkew += BACKUP_RETRY_MS + 1;
  rolling.afterSave(session(2), now);
  await turn();
  assert.equal(newest(DAILY_BACKUP).session.n, 2);
});

test("a write in flight when the clock went back doesn't bring back the stale wait", async () => {
  clean();
  const now = noonOf("2026-05-03");
  const rolling = backups();
  stub.heldSaves.on = true;
  try {
    rolling.afterSave(session(1), now + 30 * BACKUP_EVERY_MS);
    rolling.afterSave(session(2), now);
    for (const land of stub.heldSaves.queue.splice(0)) land();
    await turn();
  } finally {
    stub.heldSaves.on = false;
  }
  rolling.afterSave(session(3), now + 60_000);
  await turn();
  assert.equal(backupsOf(DAILY_BACKUP).length, 2);
  assert.ok(backupsOf(DAILY_BACKUP).some((name) => JSON.parse(stub.docs.get(name)).session.n === 3), "the corrected clock wrote its own backup");
});

test("retention counts malformed numbered files too, and still never prunes the newest clean backup", async () => {
  clean();
  const start = noonOf("2026-05-03");
  for (let i = 1; i <= 8; i++) stub.docs.set(`${DAILY_BACKUP}${100 + i}.json`, "{\"backupAt\":");
  for (let i = 1; i <= 6; i++) stub.docs.set(`${DAILY_BACKUP}${i}.json`, backupJson(start - (8 - i) * BACKUP_EVERY_MS, session(i)));
  backups().afterSave(session(7), start);
  await turn();
  const left = [...stub.docs.keys()].filter((name) => name.startsWith(DAILY_BACKUP));
  assert.equal(left.length, 7);
  assert.ok(left.every((name) => stub.docs.get(name).includes("session")), "every malformed file went");
});

test("a damaged session.json deleted while its copy retries is recreated from the session, so tabs opened since launch survive quit", async () => {
  realSession();
  stub.docs.set("session.json", "{");
  stub.refusedCopies.on = true;
  const stop = startPersistence();
  await settle();
  stub.docs.delete("session.json");
  stub.refusedCopies.on = false;
  S().createWindow({ url: "https://opened-after-launch.example/" });
  flushPersistence({ final: true });
  await finishQuitSaves(3_000);
  stop();
  resumePersistence();
  assert.ok(savedUrls().includes("https://opened-after-launch.example/"));
  assert.equal(asideCopies().length, 0, "nothing to copy: the file was gone");
});

test("if a file reappears at that name before the session is recreated, it is kept aside, not overwritten", async () => {
  realSession();
  stub.docs.set("session.json", "{");
  stub.refusedCopies.on = true;
  const stop = startPersistence();
  await settle();
  stub.docs.delete("session.json");
  stub.refusedCopies.on = false;
  stub.takenNames.add("session.json");
  try {
    S().createWindow({ url: "https://new.example/" });
    monotonicSkew += 120_000;
    await settle();
  } finally {
    stub.takenNames.clear();
  }
  stub.docs.set("session.json", "{\"reappeared\":true}");
  monotonicSkew += 120_000;
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), "{\"reappeared\":true}");
  assert.ok(savedUrls().includes("https://new.example/"));
});

test("a migration snapshot linked but not synced isn't trusted on retry until the store confirms it is durable", async () => {
  const good = JSON.parse(realSession(["https://old-version.example/"]));
  const old = JSON.stringify({ ...good, version: 9 });
  stub.docs.set("session.json", old);
  stub.linkedButUnsynced.on = true;
  stub.refusedSyncs.on = true;
  stub.syncedDocs.length = 0;
  const stop = startPersistence();
  await settle();
  stub.linkedButUnsynced.on = false;
  S().updateTab(Object.keys(S().tabs)[0], { title: "touched" });
  monotonicSkew += 120_000;
  await settle();
  assert.equal(stub.docs.get("session.json"), old, "held: the snapshot's bytes are there but not confirmed durable");
  assert.ok(stub.syncedDocs.some((name) => name.startsWith(MIGRATION_BACKUP)), "the retry asked the store to sync it");
  stub.refusedSyncs.on = false;
  monotonicSkew += 120_000;
  await settle();
  stop();
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
  assert.equal(backupsOf(MIGRATION_BACKUP).length, 1);
});

test("six occupied snapshot names that listing doesn't show are passed in one attempt, and a transient failure keeps the candidate", async () => {
  clean();
  const at = noonOf("2026-05-03");
  const rolling = backups();
  for (let i = 1; i <= 6; i++) stub.takenNames.add(`${MIGRATION_BACKUP}${i}.json`);
  try {
    stub.refusedSaves.on = true;
    await rolling.beforeMigration(session(1), at).catch(() => {});
    stub.refusedSaves.on = false;
    await rolling.beforeMigration(session(1), at);
  } finally {
    stub.takenNames.clear();
    stub.refusedSaves.on = false;
  }
  assert.deepEqual(backupsOf(MIGRATION_BACKUP), [`${MIGRATION_BACKUP}7.json`]);
});
