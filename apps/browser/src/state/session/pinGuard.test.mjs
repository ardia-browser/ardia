import assert from "node:assert/strict";
import { mock, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, resumePersistence, startPersistence } = await import("./persist.ts");
const { parsePinBackups, PINS_BACKUP_DOCUMENT } = await import("./pinGuard.ts");
const { takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const { finishQuitSaves } = await import("../app/quit.ts");
const { sessionSaved } = await import("./persist.ts");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const sharing = (on) => setConsentPeriod(on, on ? "epoch-pin-guard" : null);

const S = () => useBrowser.getState();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  flushPersistence();
  for (let i = 0; i < 4; i++) {
    await turn();
    flushPersistence();
  }
}
const sessionUrls = () => JSON.parse(stub.docs.get("session.json")).tabs.map((t) => t.url);
const backups = () => parsePinBackups(stub.docs.get(PINS_BACKUP_DOCUMENT));
const pinsIn = (w, profileId) => S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === profileId && t.pin).map((t) => t.pinnedUrl ?? t.url);
const foldersIn = (w, profileId) =>
  Object.values(S().groups).filter((g) => g.pinned && g.windowId === w && g.profileId === profileId).map((g) => [g.name, g.tabIds.map((id) => S().tabs[id].url)]);

function workShownInSecondWindowOnly() {
  const a = S().createWindow({ url: "https://a1.com" });
  const b = S().createWindow({ url: "https://b1.com" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const work = S().createProfile({ name: "Work" });
  const pin = S().newTab(b, { url: "https://pin.com", profileId: work, background: true });
  const inFolder = S().newTab(b, { url: "https://folder.com", profileId: work, background: true });
  S().newTab(b, { url: "https://loose.com", profileId: work, background: true });
  S().pinTabs([pin], true);
  S().groupTabs([inFolder], { pinned: true, name: "Folder" });
  return { a, b, work };
}

test("closing the only window that showed a profile keeps its pins on disk, and they come back after a relaunch (#2175)", () => {
  stub.docs.clear();
  stub.stagedDocs.clear();
  const stop = startPersistence();
  const { a, b, work } = workShownInSecondWindowOnly();
  flushPersistence();
  S().closeWindow(b);
  flushPersistence();
  stop();
  const saved = JSON.parse(stub.docs.get("session.json"));
  const keptUrls = [...saved.tabs.filter((t) => t.profileId === work).map((t) => t.url), ...(saved.parkedPins[work]?.tabs ?? []).map((t) => t.url)];
  assert.ok(keptUrls.includes("https://pin.com"), "the pinned tab is in session.json");
  assert.ok(keptUrls.includes("https://folder.com"), "the folder's tab is in session.json");
  S().hydrate(loadSession());
  S().switchProfile(a, work);
  assert.deepEqual(pinsIn(a, work), ["https://pin.com"]);
  assert.deepEqual(foldersIn(a, work), [["Folder", ["https://folder.com"]]]);
  assert.equal(backups().length, 0, "nothing was dropped, so no backup");
});

test("a save that drops pins keeps them in pins-backup.json, ready to park again", async () => {
  sharing(true);
  stub.docs.clear();
  stub.stagedDocs.clear();
  takeSessionWrites();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  const pin = S().newTab(w, { url: "https://pin.com", background: true });
  const inFolder = S().newTab(w, { url: "https://folder.com", background: true });
  S().pinTabs([pin], true);
  S().groupTabs([inFolder], { pinned: true, name: "Folder" });
  const profileId = S().windows[w].profileId;
  flushPersistence();
  const s = S();
  const gone = new Set([pin, inFolder]);
  useBrowser.setState({
    tabs: Object.fromEntries(Object.entries(s.tabs).filter(([id]) => !gone.has(id))),
    groups: Object.fromEntries(Object.entries(s.groups).filter(([, g]) => !g.pinned)),
    windows: { ...s.windows, [w]: { ...s.windows[w], tabIds: s.windows[w].tabIds.filter((id) => !gone.has(id)) } },
  });
  await settle();
  stop();
  const [kept] = backups();
  assert.deepEqual(kept.dropped, { [profileId]: 3 }, "the pin, the folder and its tab");
  const pins = kept.pins[profileId];
  assert.deepEqual(pins.tabs.map((t) => t.url).sort(), ["https://folder.com", "https://pin.com"]);
  assert.deepEqual(pins.groups.map((g) => g.name), ["Folder"]);
  const counts = takeSessionWrites();
  assert.equal(counts.session_pin_backups, 1);
  assert.equal(counts.session_pins_backed_up, 3);
  sharing(false);
  S().closeWindow(w);
  useBrowser.setState({ parkedPins: { ...S().parkedPins, [profileId]: pins } });
  const n = S().createWindow({ url: "https://b1.com" });
  assert.ok(pinsIn(n, profileId).includes("https://pin.com"), "parking the backup brings the pin back");
  assert.deepEqual(foldersIn(n, profileId), [["Folder", ["https://folder.com"]]]);
});

test("closing a window whose pins stay in another window or the park, or deleting a profile, keeps no backup", () => {
  stub.docs.clear();
  stub.stagedDocs.clear();
  const stop = startPersistence();
  const a = S().createWindow({ url: "https://a1.com" });
  const pin = S().newTab(a, { url: "https://pin.com", background: true });
  S().pinTabs([pin], true);
  const b = S().createWindow({ url: "https://b1.com" });
  const work = S().createProfile({ name: "Work" });
  const workPin = S().newTab(b, { url: "https://work-pin.com", profileId: work, background: true });
  S().pinTabs([workPin], true);
  flushPersistence();
  S().closeWindow(b);
  flushPersistence();
  assert.equal(backups().length, 0, "the closed window's pins live on in the open window or parked");
  S().deleteProfile(work);
  flushPersistence();
  stop();
  assert.equal(backups().filter((x) => x.profileId === work).length, 0, "a deleted profile's pins aren't backed up");
});

function dropPins(ids) {
  const s = S();
  const gone = new Set(ids);
  useBrowser.setState({
    tabs: Object.fromEntries(Object.entries(s.tabs).filter(([id]) => !gone.has(id))),
    windows: Object.fromEntries(Object.entries(s.windows).map(([id, w]) => [id, { ...w, tabIds: w.tabIds.filter((t) => !gone.has(t)) }])),
  });
}

test("the backup keeps two pins of the same page that parking would merge", async () => {
  stub.docs.clear();
  stub.stagedDocs.clear();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  const one = S().newTab(w, { url: "https://example.com/page", background: true });
  const two = S().newTab(w, { url: "https://example.com/page#notes", background: true });
  S().pinTabs([one, two], true);
  const profileId = S().windows[w].profileId;
  flushPersistence();
  dropPins([one, two]);
  await settle();
  stop();
  const [kept] = backups();
  assert.deepEqual(kept.pins[profileId].tabs.map((t) => t.url).sort(), ["https://example.com/page", "https://example.com/page#notes"]);
});

function onePin() {
  stub.docs.clear();
  stub.stagedDocs.clear();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  const pin = S().newTab(w, { url: "https://pin.com", background: true });
  S().pinTabs([pin], true);
  flushPersistence();
  assert.ok(sessionUrls().includes("https://pin.com"));
  return { stop, w, pin, profileId: S().windows[w].profileId };
}

test("when the session write fails after the backup landed, the next save writes it and the backup isn't repeated", async () => {
  const { stop, w, pin, profileId } = onePin();
  stub.refusedWrites.on = true;
  try {
    dropPins([pin]);
    await settle();
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.equal(backups().length, 1, "the backup landed");
  assert.ok(sessionUrls().includes("https://pin.com"), "the session write was refused");
  S().newTab(w, { url: "https://other.com", background: true });
  await settle();
  stop();
  const kept = backups();
  assert.equal(kept.length, 1, "not backed up twice");
  assert.deepEqual(kept[0].pins[profileId].tabs.map((t) => t.url), ["https://pin.com"]);
  assert.ok(!sessionUrls().includes("https://pin.com"));
});


test("a failing backup write holds the session write that drops pins, and both land once the backup does", async () => {
  const { stop, pin, profileId } = onePin();
  const realNow = Date.now;
  stub.refusedSaves.on = true;
  try {
    dropPins([pin]);
    await settle();
    assert.ok(sessionUrls().includes("https://pin.com"), "session.json still has the pin while the backup can't be written");
    assert.equal(backups().length, 0);
    await settle();
    assert.ok(sessionUrls().includes("https://pin.com"), "and still after another save");
  } finally {
    stub.refusedSaves.on = false;
  }
  const later = realNow() + 120_000;
  Date.now = () => later;
  try {
    await settle();
  } finally {
    Date.now = realNow;
  }
  stop();
  assert.deepEqual(backups()[0]?.pins[profileId]?.tabs.map((t) => t.url), ["https://pin.com"], "the backup landed on the retry");
  assert.ok(!sessionUrls().includes("https://pin.com"), "and then the session was written");
});

test("a slow backup write holds the session write until the backup has landed", async () => {
  const { stop, pin, profileId } = onePin();
  stub.heldSaves.on = true;
  try {
    dropPins([pin]);
    await settle();
    assert.ok(sessionUrls().includes("https://pin.com"), "session.json keeps the pin while the backup is landing");
    assert.equal(backups().length, 0);
  } finally {
    stub.heldSaves.on = false;
  }
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  stop();
  assert.deepEqual(backups()[0]?.pins[profileId]?.tabs.map((t) => t.url), ["https://pin.com"]);
  assert.ok(!sessionUrls().includes("https://pin.com"));
});

test("quitting while the backup can't be written keeps the old session.json, and doesn't wait", async () => {
  const { stop, pin } = onePin();
  stub.refusedSaves.on = true;
  try {
    dropPins([pin]);
    await settle();
    const started = Date.now();
    flushPersistence({ final: true });
    assert.ok(Date.now() - started < 100, "the final save returns at once");
    assert.ok(sessionUrls().includes("https://pin.com"), "the session on disk keeps the pin");
  } finally {
    stub.refusedSaves.on = false;
    stop();
    resumePersistence();
  }
});

test("saves that drop no pins write the session at once and never touch the backup", () => {
  const { stop, w } = onePin();
  const documents = stub.shellNativeModules.ArdiaDocuments;
  const realSave = documents.saveDocument;
  let backupSaves = 0;
  documents.saveDocument = (name, contents) => {
    if (name === PINS_BACKUP_DOCUMENT) backupSaves++;
    return realSave(name, contents);
  };
  try {
    S().newTab(w, { url: "https://more.com", background: true });
    flushPersistence();
  } finally {
    documents.saveDocument = realSave;
    stop();
  }
  assert.ok(sessionUrls().includes("https://more.com"), "written in the same flush, no wait");
  assert.equal(backupSaves, 0);
});

const microtasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
async function elapse(ms) {
  for (let at = 0; at < ms; at += 250) {
    mock.timers.tick(250);
    await microtasks();
  }
}

function twoProfilePins() {
  stub.docs.clear();
  stub.stagedDocs.clear();
  const stop = startPersistence();
  const a = S().createWindow({ url: "https://a1.com" });
  const pinA = S().newTab(a, { url: "https://pin-a.com", background: true });
  S().pinTabs([pinA], true);
  const work = S().createProfile({ name: "Work" });
  const b = S().createWindow({ url: "https://b1.com", profileId: work });
  const pinB = S().newTab(b, { url: "https://pin-b.com", profileId: work, background: true });
  S().pinTabs([pinB], true);
  flushPersistence();
  return { stop, a, pinA, pinB, personal: S().windows[a].profileId, work };
}

test("a save during the retry wait doesn't cancel the retry: the session lands on its own once the backup does", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { stop, w, pin } = onePin();
  try {
    stub.refusedSaves.on = true;
    dropPins([pin]);
    flushPersistence();
    await microtasks();
    stub.refusedSaves.on = false;
    S().newTab(w, { url: "https://during-wait.com", background: true });
    flushPersistence();
    assert.ok(sessionUrls().includes("https://pin.com"), "still held during the wait");
    await elapse(3_000);
    assert.equal(backups().length, 1, "the retry landed the backup");
    assert.ok(!sessionUrls().includes("https://pin.com"), "and the session followed without another change");
  } finally {
    stop();
    mock.timers.reset();
  }
});

test("retries never pile up entries: one backup entry covers every profile of one unsaved state, and an earlier profile isn't evicted", async () => {
  sharing(true);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { stop, pinA, pinB, personal, work } = twoProfilePins();
  takeSessionWrites();
  try {
    stub.heldSaves.on = true;
    dropPins([pinA]);
    flushPersistence();
    dropPins([pinB]);
    flushPersistence();
    stub.heldSaves.on = false;
    stub.refusedSaves.on = true;
    for (const land of stub.heldSaves.queue.splice(0)) land();
    await microtasks();
    for (let i = 0; i < 25; i++) await elapse(60_000);
    stub.refusedSaves.on = false;
    await elapse(60_000);
    assert.ok(!sessionUrls().includes("https://pin-a.com") && !sessionUrls().includes("https://pin-b.com"), "the session is saved at last");
    const kept = backups();
    assert.equal(kept.length, 1, "one entry, not one per retry");
    assert.deepEqual(kept[0].pins[personal]?.tabs.map((t) => t.url), ["https://pin-a.com"], "the first profile's pins are still kept");
    assert.deepEqual(kept[0].pins[work]?.tabs.map((t) => t.url), ["https://pin-b.com"]);
    const counts = takeSessionWrites();
    assert.equal(counts.session_pin_backups, 2, "each landing counted once, when it landed");
    assert.equal(counts.session_pins_backed_up, 2);
  } finally {
    sharing(false);
    stub.refusedSaves.on = false;
    stub.heldSaves.on = false;
    stop();
    mock.timers.reset();
  }
});

test("sessionSaved waits through a second backup that starts while the first lands", async () => {
  const { stop, pinA, pinB } = twoProfilePins();
  try {
    stub.heldSaves.on = true;
    dropPins([pinA]);
    const answer = sessionSaved();
    await turn();
    dropPins([pinB]);
    for (const land of stub.heldSaves.queue.splice(0)) land();
    await turn();
    for (const land of stub.heldSaves.queue.splice(0)) land();
    stub.heldSaves.on = false;
    for (let i = 0; i < 5; i++) {
      await turn();
      for (const land of stub.heldSaves.queue.splice(0)) land();
    }
    assert.equal(await answer, true);
    assert.ok(!sessionUrls().includes("https://pin-a.com") && !sessionUrls().includes("https://pin-b.com"));
  } finally {
    stub.heldSaves.on = false;
    stop();
  }
});

test("quitting while a healthy backup is still landing writes the session once it lands, within the quit wait", async () => {
  const { stop, pin } = onePin();
  try {
    stub.heldSaves.on = true;
    dropPins([pin]);
    flushPersistence({ final: true });
    assert.ok(sessionUrls().includes("https://pin.com"), "nothing that drops the pin went out yet");
    const quit = finishQuitSaves(3_000);
    stub.heldSaves.on = false;
    for (const land of stub.heldSaves.queue.splice(0)) land();
    await quit;
    assert.equal(backups().length, 1);
    assert.ok(!sessionUrls().includes("https://pin.com"), "the session followed the backup before quitting");
  } finally {
    stub.heldSaves.on = false;
    stop();
    resumePersistence();
  }
});

test("each failed backup try is counted once, only while sharing, and nothing else is sent with it", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { stop, pin } = onePin();
  takeSessionWrites();
  try {
    sharing(true);
    stub.refusedSaves.on = true;
    dropPins([pin]);
    flushPersistence();
    await microtasks();
    await elapse(2_000);
    assert.equal(takeSessionWrites().session_pin_backup_failures, 2, "the first try and one retry");
    sharing(false);
    await elapse(4_000);
    assert.equal(takeSessionWrites().session_pin_backup_failures, 0, "not counted while sharing is off");
  } finally {
    stub.refusedSaves.on = false;
    sharing(false);
    stop();
    mock.timers.reset();
  }
});

test("quitting while a second backup starts behind the first still writes the session once both land (round 2, R4)", async () => {
  const { stop, pinA, pinB } = twoProfilePins();
  try {
    stub.heldSaves.on = true;
    dropPins([pinA]);
    flushPersistence();
    dropPins([pinB]);
    flushPersistence({ final: true });
    const quit = finishQuitSaves(3_000);
    stub.heldSaves.on = false;
    for (let i = 0; i < 6; i++) {
      for (const land of stub.heldSaves.queue.splice(0)) land();
      await turn();
    }
    await quit;
    assert.ok(!sessionUrls().includes("https://pin-a.com") && !sessionUrls().includes("https://pin-b.com"), "the session followed both backups before quitting");
  } finally {
    stub.heldSaves.on = false;
    stop();
    resumePersistence();
  }
});

test("a profile deleted while its backup waits is left out of the backup (round 2, C)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { stop, pinA, pinB, work } = twoProfilePins();
  try {
    stub.refusedSaves.on = true;
    dropPins([pinA]);
    flushPersistence();
    dropPins([pinB]);
    flushPersistence();
    S().deleteProfile(work);
    await microtasks();
    stub.refusedSaves.on = false;
    await elapse(3_000);
    const kept = backups();
    assert.equal(kept.length, 1);
    assert.equal(kept[0].pins[work], undefined, "nothing of the deleted profile is written");
  } finally {
    stub.refusedSaves.on = false;
    stub.heldSaves.on = false;
    stop();
    mock.timers.reset();
  }
});

test("a pins-backup.json that can't be read is kept, and the new backup goes beside it (round 2, E)", async () => {
  const { stop, pin, profileId } = onePin();
  stub.docs.set(PINS_BACKUP_DOCUMENT, "{ not json");
  try {
    dropPins([pin]);
    await settle();
  } finally {
    stop();
  }
  assert.equal(stub.docs.get(PINS_BACKUP_DOCUMENT), "{ not json", "the unreadable file is left alone");
  const beside = [...stub.docs.keys()].filter((name) => name.startsWith("pins-backup-") && name.endsWith(".json"));
  assert.equal(beside.length, 1);
  assert.deepEqual(parsePinBackups(stub.docs.get(beside[0]))[0].pins[profileId].tabs.map((t) => t.url), ["https://pin.com"]);
  assert.ok(!sessionUrls().includes("https://pin.com"));
});

test("two backups beside an unreadable pins-backup.json never share a file name, even in the same millisecond", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { stop, w, pin } = onePin();
  stub.docs.set(PINS_BACKUP_DOCUMENT, "{ not json");
  try {
    dropPins([pin]);
    await settle();
    const again = S().newTab(w, { url: "https://pin-two.com", background: true });
    S().pinTabs([again], true);
    flushPersistence();
    dropPins([again]);
    await settle();
  } finally {
    stop();
    mock.timers.reset();
  }
  const beside = [...stub.docs.keys()].filter((name) => name.startsWith("pins-backup-"));
  assert.equal(beside.length, 2, "one file per backup");
  assert.deepEqual(beside.map((name) => parsePinBackups(stub.docs.get(name))[0].pins).flatMap((pins) => Object.values(pins).flatMap((p) => p.tabs.map((t) => t.url))).sort(), ["https://pin-two.com", "https://pin.com"]);
});

test("a backup that lands after its profile was deleted still counts the pins it carried", async () => {
  const { stop, pinA, pinB, personal } = twoProfilePins();
  sharing(true);
  takeSessionWrites();
  try {
    stub.heldSaves.on = true;
    dropPins([pinA]);
    flushPersistence();
    dropPins([pinB]);
    S().deleteProfile(personal);
    flushPersistence();
    stub.heldSaves.on = false;
    for (let i = 0; i < 4; i++) {
      for (const land of stub.heldSaves.queue.splice(0)) land();
      await turn();
    }
    const counts = takeSessionWrites();
    assert.equal(counts.session_pin_backups, 2);
    assert.equal(counts.session_pins_backed_up, 2, "the deleted profile's landed pin is counted, not 0");
  } finally {
    stub.heldSaves.on = false;
    sharing(false);
    stop();
  }
});

test("a quit cancelled while a backup lands doesn't leave saving frozen: later changes still reach session.json", async () => {
  const { stop, w, pin } = onePin();
  try {
    stub.heldSaves.on = true;
    dropPins([pin]);
    flushPersistence({ final: true });
    const quit = finishQuitSaves(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await quit;
    resumePersistence();
    stub.heldSaves.on = false;
    for (let i = 0; i < 4; i++) {
      for (const land of stub.heldSaves.queue.splice(0)) land();
      await turn();
    }
    S().newTab(w, { url: "https://after-cancel.com", background: true });
    await settle();
    assert.ok(sessionUrls().includes("https://after-cancel.com"), "saving still runs after the cancelled quit");
  } finally {
    stub.heldSaves.on = false;
    stop();
    resumePersistence();
  }
});

test("a held session write that drops pins is counted as a real write, not a cosmetic one", async () => {
  const { stop, pin } = onePin();
  takeSessionWrites();
  try {
    stub.heldSaves.on = true;
    dropPins([pin]);
    flushPersistence();
    stub.heldSaves.on = false;
    for (const land of stub.heldSaves.queue.splice(0)) land();
    await settle();
    const counts = takeSessionWrites();
    assert.equal(counts.session_writes, 1);
    assert.equal(counts.session_cosmetic_writes, 0);
  } finally {
    stub.heldSaves.on = false;
    stop();
  }
});
