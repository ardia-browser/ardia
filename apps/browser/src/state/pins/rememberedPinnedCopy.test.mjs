import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { startPinHandoff, pinHandOffOf } = await import("./pinHandoff.ts");
const { activeTabId, familyKeyOf } = await import("../browser/model.ts");

const S = () => useBrowser.getState();

function withTickingClock(run) {
  let now = Date.UTC(2026, 10, 20, 12);
  const realNow = Date.now;
  Date.now = () => (now += 1000);
  const restore = () => {
    Date.now = realNow;
  };
  let result;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

const missingActiveTabs = () =>
  Object.values(S().windows).flatMap((w) => Object.entries(w.activeTabIds).filter(([, id]) => !S().tabs[id]).map(([profileId]) => `${w.id} ${profileId}`));

const wrongWindowActiveTabs = () =>
  Object.values(S().windows).flatMap((w) =>
    Object.entries(w.activeTabIds).filter(([profileId, id]) => S().tabs[id] && (S().tabs[id].windowId !== w.id || S().tabs[id].profileId !== profileId)).map(([profileId]) => `${w.id} ${profileId}`),
  );

function settled() {
  assert.deepEqual(missingActiveTabs(), []);
  assert.deepEqual(wrongWindowActiveTabs(), []);
}

function twoWindowsOnePinRememberedAcrossProfiles() {
  S().hydrate({});
  const a = S().createWindow({ url: "https://mail.example/" });
  const [mail] = S().windows[a].tabIds;
  S().newTab(a, { url: "https://a.example/" });
  S().pinTabs([mail], true);
  const b = S().createWindow({ url: "https://b.example/" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const work = S().createProfile({ name: "Work" });
  const pinIn = (w) => Object.values(S().tabs).find((t) => t.windowId === w && t.pin).id;
  S().activate(pinIn(b));
  S().activate(pinIn(a));
  S().switchProfile(b, work);
  return { a, b, work, pinIn };
}

test("unpinning a shared pin leaves every window's remembered tab pointing at a tab that exists", () => {
  withTickingClock(() => {
    const { a, b, pinIn } = twoWindowsOnePinRememberedAcrossProfiles();
    const remembered = S().windows[b].activeTabIds.default;
    assert.ok(S().tabs[remembered]?.pin, "the second window remembers its copy of the pin for the default profile");
    S().pinTabs([pinIn(a)], false);
    settled();
  });
});

test("after unpinning, switching the other window back to the profile shows a tab", () => {
  withTickingClock(() => {
    const { b, pinIn, a } = twoWindowsOnePinRememberedAcrossProfiles();
    S().pinTabs([pinIn(a)], false);
    S().switchProfile(b, "default");
    const shown = S().windows[b].activeTabIds.default;
    assert.ok(S().tabs[shown], "the window shows a tab of the profile");
    assert.equal(S().tabs[shown].windowId, b);
    settled();
  });
});

test("with three windows, every window that remembered a copy of the unpinned tab drops it", () => {
  withTickingClock(() => {
    S().hydrate({});
    const a = S().createWindow({ url: "https://mail.example/" });
    const [mail] = S().windows[a].tabIds;
    S().pinTabs([mail], true);
    const b = S().createWindow({ url: "https://b.example/" });
    const c = S().createWindow({ url: "https://c.example/" });
    S().updateSettings({ shareTabsAcrossWindows: true });
    const work = S().createProfile({ name: "Work" });
    const pinIn = (w) => Object.values(S().tabs).find((t) => t.windowId === w && t.pin)?.id;
    S().activate(pinIn(b));
    S().activate(pinIn(c));
    S().activate(pinIn(a));
    S().switchProfile(b, work);
    S().switchProfile(c, work);
    assert.ok(S().tabs[S().windows[b].activeTabIds.default]?.pin);
    assert.ok(S().tabs[S().windows[c].activeTabIds.default]?.pin);
    S().pinTabs([pinIn(a)], false);
    settled();
    for (const w of [b, c]) {
      const kept = S().windows[w].activeTabIds.default;
      assert.ok(kept === undefined || S().tabs[kept]?.windowId === w);
    }
  });
});

function folderMirroredInTwoWindowsRememberedByOne() {
  S().hydrate({});
  S().updateSettings({ shareTabsAcrossWindows: true });
  const work = S().createProfile({ name: "Work" });
  const a = S().createWindow({ url: "https://s1.example/" });
  const b = S().createWindow({ url: "https://s2.example/" });
  const tabB = S().windows[b].tabIds.find((id) => S().tabs[id].windowId === b && S().tabs[id].url.includes("s2"));
  S().groupTabs([tabB], { pinned: true });
  const folderIn = (w) => Object.values(S().groups).find((g) => g.windowId === w && g.pinned);
  S().activate(folderIn(b).tabIds[0]);
  S().activate(folderIn(a).tabIds[0]);
  S().switchProfile(b, work);
  const remembered = S().windows[b].activeTabIds.default;
  assert.ok(S().tabs[remembered]?.windowId === b, "the second window remembers its copy of the folder's tab for the default profile");
  return { a, b, work, remembered, folderIn };
}

test("ungrouping a pinned folder keeps every window's remembered tab valid", () => {
  withTickingClock(() => {
    const { a, folderIn } = folderMirroredInTwoWindowsRememberedByOne();
    S().ungroup(folderIn(a).id);
    settled();
  });
});

test("taking the tab out of a pinned folder keeps every window's remembered tab valid", () => {
  withTickingClock(() => {
    const { a, folderIn } = folderMirroredInTwoWindowsRememberedByOne();
    S().removeTabsFromGroup([folderIn(a).tabIds[0]]);
    settled();
  });
});

test("deleting a pinned folder keeps every window's remembered tab valid", () => {
  withTickingClock(() => {
    const { a, folderIn } = folderMirroredInTwoWindowsRememberedByOne();
    S().deleteGroup(folderIn(a).id);
    settled();
  });
});

test("unpinning then ungrouping a folder does not lose a live page through a sleeping remembered copy", () => {
  withTickingClock(() => {
    const url = (n) => `https://${n}.example/`;
    S().hydrate({});
    S().updateSettings({ shareTabsAcrossWindows: true });
    const work = S().createProfile({ name: "Work" });
    const a = S().createWindow({ url: url("mail") });
    const [mail] = S().windows[a].tabIds;
    const x0 = S().newTab(a, { url: url("x0") });
    const x1 = S().newTab(a, { url: url("x1") });
    S().groupTabs([x0, x1], { pinned: true });
    S().pinTabs([mail], true);
    const b = S().createWindow({ url: url("b") });
    const at = (w, n) => S().windows[w].tabIds.map((id) => S().tabs[id]).find((t) => t.url === url(n));
    S().activate(at(b, "mail").id);
    S().activate(at(a, "x0").id);
    S().activate(at(a, "mail").id);
    S().switchProfile(b, work);
    S().closeTab(at(a, "b").id);
    S().pinTabs([at(a, "mail").id], false);
    S().ungroup(Object.values(S().groups).find((g) => g.windowId === a && g.pinned).id);
    settled();
    for (const n of ["x0", "x1"]) assert.ok(Object.values(S().tabs).some((t) => t.url === url(n)), n);
    assert.equal(at(a, "x0")?.page.kind, "loaded");
  });
});

test("with sharing off, unpinning leaves the other windows' tabs alone", () => {
  withTickingClock(() => {
    S().hydrate({});
    const a = S().createWindow({ url: "https://mail.example/" });
    const [mail] = S().windows[a].tabIds;
    const b = S().createWindow({ url: "https://b.example/" });
    const before = Object.values(S().tabs).filter((t) => t.windowId === b).map((t) => t.id).sort();
    S().pinTabs([mail], true);
    S().pinTabs([mail], false);
    const after = Object.values(S().tabs).filter((t) => t.windowId === b).map((t) => t.id).sort();
    assert.deepEqual(after, before);
    settled();
  });
});

test("renaming a pin in another window while a click on a frozen pin is handing off does not cancel the hand-off", () =>
  withTickingClock(async () => {
    S().hydrate({});
    S().updateSettings({ shareTabsAcrossWindows: true });
    const a = S().createWindow({ url: "https://mail.example/" });
    const [mail] = S().windows[a].tabIds;
    const other = S().newTab(a, { url: "https://other.example/" });
    S().pinTabs([mail, other], true);
    S().newTab(a, { url: "https://plain.example/" });
    const b = S().createWindow({ url: "https://b.example/" });
    const inWindow = (w, url) => S().windows[w].tabIds.find((id) => S().tabs[id].url === url);
    const copy = inWindow(b, "https://mail.example/");
    S().activate(copy);
    S().activate(mail);
    const holder = [mail, copy].find((id) => S().tabs[id].page.kind === "loaded");
    const frozen = [mail, copy].find((id) => S().tabs[id].page.kind === "frozen");
    assert.ok(holder && frozen, "one copy holds the page and the other is frozen");
    const holderWindow = S().tabs[holder].windowId;
    const clickedWindow = S().tabs[frozen].windowId;
    assert.notEqual(holderWindow, clickedWindow);
    const realGet = webviews.get;
    const stop = startPinHandoff();
    let release;
    const picture = new Promise((resolve) => (release = resolve));
    webviews.get = () => ({ capturePicture: () => picture });
    try {
      S().activate(frozen);
      const flight = pinHandOffOf(familyKeyOf(S().tabs[frozen]));
      assert.ok(flight, "clicking the frozen pin starts a hand-off");
      S().updateTab(inWindow(holderWindow, "https://other.example/"), { customTitle: "Renamed" });
      release({ data: "x" });
      await flight;
      const shown = S().tabs[activeTabId(S(), clickedWindow)];
      assert.equal(shown.url, "https://mail.example/");
      assert.equal(shown.page.kind, "loaded");
    } finally {
      webviews.get = realGet;
      stop();
    }
  }));
