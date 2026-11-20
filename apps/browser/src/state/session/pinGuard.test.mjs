import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, startPersistence } = await import("./persist.ts");
const { parsePinBackups, PINS_BACKUP_DOCUMENT } = await import("./pinGuard.ts");
const { takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
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

test("a save that drops pins keeps them in pins-backup.json, ready to park again", () => {
  stub.docs.clear();
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
  flushPersistence();
  stop();
  const [kept] = backups();
  assert.equal(kept.profileId, profileId);
  assert.equal(kept.dropped, 3, "the pin, the folder and its tab");
  assert.deepEqual(kept.pins.tabs.map((t) => t.url).sort(), ["https://folder.com", "https://pin.com"]);
  assert.deepEqual(kept.pins.groups.map((g) => g.name), ["Folder"]);
  const counts = takeSessionWrites();
  assert.equal(counts.session_pin_backups, 1);
  assert.equal(counts.session_pins_backed_up, 3);
  S().closeWindow(w);
  useBrowser.setState({ parkedPins: { ...S().parkedPins, [profileId]: kept.pins } });
  const n = S().createWindow({ url: "https://b1.com" });
  assert.ok(pinsIn(n, profileId).includes("https://pin.com"), "parking the backup brings the pin back");
  assert.deepEqual(foldersIn(n, profileId), [["Folder", ["https://folder.com"]]]);
});

test("closing a window whose pins stay in another window or the park, or deleting a profile, keeps no backup", () => {
  stub.docs.clear();
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
