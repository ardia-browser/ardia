import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { cleanUpCandidates, nextCleanUpAt, noteDeselectedTabs } = await import("./tabCleanup.ts");
const { nextAutoCleanUpAt, startAutoCleanUp, stopAutoCleanUp } = await import("./autoCleanUp.ts");
const { takeCleanUpCounts } = await import("../telemetry/cleanUpCounts.ts");

const S = () => useBrowser.getState();
const MIN = 60_000;

function windowWith(...urls) {
  S().hydrate({});
  S().updateSettings({ newTabPosition: "bottom" });
  const w = S().createWindow({ url: `https://${urls[0]}.com/` });
  const ids = [model.viewTabIds(S(), w)[0], ...urls.slice(1).map((u) => S().newTab(w, { url: `https://${u}.com/`, background: true }))];
  S().activate(ids[0]);
  return [w, ...ids];
}

test("the next clean-up is due when the longest-idle tab that can go reaches the time; pinned and selected tabs never count", () => {
  const [w, a, b, c, d] = windowWith("a", "b", "c", "d");
  const now = Date.now();
  S().updateTab(a, { lastActiveAt: now - 50 * MIN });
  S().updateTab(b, { lastActiveAt: now - 20 * MIN });
  S().updateTab(c, { lastActiveAt: now - 5 * MIN });
  S().updateTab(d, { lastActiveAt: now - 90 * MIN });
  S().pinTabs([d], true);
  assert.equal(nextCleanUpAt(S(), w, 30 * MIN), now + 10 * MIN);
  assert.deepEqual(cleanUpCandidates(S(), w, 30 * MIN, now), []);
  assert.deepEqual(cleanUpCandidates(S(), w, 30 * MIN, now + 10 * MIN), [b]);
});

test("automatic clean-up is off without a time, and otherwise checks again within the time or half an hour", () => {
  const [w, , b] = windowWith("a", "b");
  const now = Date.now();
  S().updateSettings({ cleanUpInactiveTabsAfterMinutes: null });
  assert.equal(nextAutoCleanUpAt(S(), now), null);
  S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 * 24 * 60 });
  assert.equal(nextAutoCleanUpAt(S(), now), now + 30 * MIN);
  S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 5 });
  S().updateTab(b, { lastActiveAt: now });
  assert.equal(nextAutoCleanUpAt(S(), now), now + 5 * MIN);
  S().updateTab(b, { lastActiveAt: now - 3 * MIN });
  assert.equal(nextAutoCleanUpAt(S(), now), now + 2 * MIN);
  assert.ok(S().windows[w]);
});

test("automatic clean-up wakes when the next tab is due and honours minutes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w, a, b, c] = windowWith("a", "b", "c");
    S().updateTab(b, { lastActiveAt: Date.now() - 29 * MIN });
    S().updateTab(c, { lastActiveAt: Date.now() - 10 * MIN });
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 });
    t.mock.timers.tick(59_000);
    assert.ok(S().tabs[b], "not idle for 30 minutes yet");
    t.mock.timers.tick(2_000);
    assert.ok(!S().tabs[b], "closed once it reached 30 minutes");
    assert.ok(S().tabs[c] && S().tabs[a]);
    t.mock.timers.tick(19 * MIN);
    assert.ok(!S().tabs[c]);
    assert.ok(S().tabs[a], "the selected tab stays");
    assert.deepEqual(S().cleanedTabs.slice(-2).map((e) => e.tab.url), ["https://b.com/", "https://c.com/"]);
    assert.equal(model.viewTabIds(S(), w).length, 1);
  } finally {
    stopAutoCleanUp();
  }
});

test("a tab you were on counts as used until you leave it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w, a, b] = windowWith("a", "b");
    S().updateTab(a, { lastActiveAt: Date.now() - 2 * 60 * MIN });
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 });
    t.mock.timers.tick(MIN);
    S().activate(b);
    t.mock.timers.tick(29 * MIN);
    assert.ok(S().tabs[a], "left 29 minutes ago");
    assert.deepEqual(cleanUpCandidates(S(), w, 30 * MIN), []);
    t.mock.timers.tick(MIN + 1000);
    assert.ok(!S().tabs[a], "left 30 minutes ago");
  } finally {
    stopAutoCleanUp();
  }
});

test("tabs brought back by Restore All or a reopened window count as used when they come back, and keep their last-use time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w, , b, c] = windowWith("a", "b", "c");
    const usedAt = Date.now() - 2 * 60 * MIN;
    S().updateTab(b, { lastActiveAt: usedAt });
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 });
    t.mock.timers.tick(1000);
    assert.ok(!S().tabs[b], "cleaned up");
    S().restoreCleaned();
    const back = model.viewTabIds(S(), w).find((id) => S().tabs[id].url === "https://b.com/");
    assert.equal(S().tabs[back].lastActiveAt, usedAt);
    assert.deepEqual(cleanUpCandidates(S(), w, 30 * MIN), [], "just restored");
    S().updateTab(c, { lastActiveAt: usedAt });
    S().createWindow();
    S().closeWindow(w);
    const open = new Set(S().windowOrder);
    S().reopenClosedWindow();
    const reopened = S().windowOrder.find((id) => !open.has(id));
    const old = model.viewTabIds(S(), reopened).find((id) => S().tabs[id].url === "https://c.com/");
    assert.equal(S().tabs[old].lastActiveAt, usedAt);
    assert.ok(!cleanUpCandidates(S(), reopened, 30 * MIN).includes(old), "just reopened");
    t.mock.timers.tick(29 * MIN);
    assert.ok(S().tabs[old], "reopened 29 minutes ago");
    t.mock.timers.tick(2 * MIN);
    assert.ok(!S().tabs[old], "reopened 31 minutes ago and not used since");
  } finally {
    stopAutoCleanUp();
  }
});

test("with tabs shared across windows, a restored tab and its copy in the other window both count as used when it came back, even after the source window closes", () => {
  const [w, , b] = windowWith("a", "b", "c", "d");
  S().updateSettings({ shareTabsAcrossWindows: true });
  S().createWindow();
  const usedAt = Date.now() - 2 * 60 * MIN;
  for (const t of Object.values(S().tabs)) if (t.url === "https://b.com/") S().updateTab(t.id, { lastActiveAt: usedAt });
  S().cleanUpTabs(w, { inactiveForMs: 30 * MIN });
  assert.ok(!S().tabs[b], "cleaned up");
  S().restoreCleaned();
  const copies = Object.values(S().tabs).filter((t) => t.url === "https://b.com/");
  assert.equal(copies.length, 2, "one in each window");
  for (const id of S().windowOrder) S().cleanUpTabs(id, { inactiveForMs: 30 * MIN });
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://b.com/").length, 2);
  S().closeWindow(w);
  for (const id of S().windowOrder) S().cleanUpTabs(id, { inactiveForMs: 30 * MIN });
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://b.com/").length, 1, "the copy stays after its source window closes");
});

test("with tabs shared across windows, clean-up waits for the latest restore of any copy", () => {
  const [w, , b] = windowWith("a", "b", "c", "d");
  S().updateSettings({ shareTabsAcrossWindows: true });
  const other = S().createWindow();
  const usedAt = Date.now() - 2 * 60 * MIN;
  const copies = () => Object.values(S().tabs).filter((t) => t.url === "https://b.com/");
  for (const t of copies()) S().updateTab(t.id, { lastActiveAt: usedAt, restoredAt: t.windowId === w ? usedAt : Date.now() });
  assert.equal(copies().length, 2);
  assert.deepEqual(cleanUpCandidates(S(), w, 30 * MIN).filter((id) => id === b), []);
  S().cleanUpTabs(w, { inactiveForMs: 30 * MIN });
  assert.equal(copies().length, 2, "the copy restored just now keeps both");
  assert.ok(S().windows[other]);
});

test("Restore All on a page that's open again keeps the restored tab and cleans up the other copy", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const [w, , b] = windowWith("a", "b", "c", "d");
  S().updateTab(b, { lastActiveAt: Date.now() - 2 * 60 * MIN });
  S().cleanUpTabs(w, { inactiveForMs: 30 * MIN });
  assert.ok(!S().tabs[b], "cleaned up");
  t.mock.timers.tick(MIN);
  const again = S().newTab(w, { url: "https://b.com/", background: true });
  t.mock.timers.tick(MIN);
  S().restoreCleaned();
  const restored = model.viewTabIds(S(), w).find((id) => id !== again && S().tabs[id].url === "https://b.com/");
  assert.deepEqual(cleanUpCandidates(S(), w, 30 * MIN), [again]);
  S().cleanUpTabs(w, { inactiveForMs: 30 * MIN });
  assert.ok(!S().tabs[again], "the other copy is cleaned up");
  assert.ok(S().tabs[restored], "the restored tab stays");
});

test("switching the setting off stops the timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [, , b] = windowWith("a", "b");
    S().updateTab(b, { lastActiveAt: Date.now() - 29 * MIN });
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 });
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: null });
    t.mock.timers.tick(60 * MIN);
    assert.ok(S().tabs[b]);
  } finally {
    stopAutoCleanUp();
  }
});

test("automatic clean-up reaches profiles the window isn't showing, and keeps each profile's selected tab", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w, a] = windowWith("a");
    const home = S().windows[w].profileId;
    const work = S().createProfile({ name: "Work" });
    S().switchProfile(w, work);
    const selected = model.activeTabId(S(), w);
    const b = S().newTab(w, { url: "https://b.com/", background: true });
    S().switchProfile(w, home);
    takeCleanUpCounts();
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 });
    t.mock.timers.tick(31 * MIN);
    assert.ok(!S().tabs[b], "the idle tab in the hidden profile is cleaned up");
    assert.deepEqual(takeCleanUpCounts(), { clean_up_auto_tabs: 1, clean_up_auto_hidden_profile_tabs: 1 });
    assert.ok(S().tabs[selected] && S().tabs[a], "each profile's selected tab stays");
    assert.equal(S().cleanedTabs.at(-1).tab.url, "https://b.com/");
  } finally {
    stopAutoCleanUp();
  }
});

test("the next automatic clean-up counts tabs in profiles the window isn't showing", () => {
  const [w] = windowWith("a");
  const home = S().windows[w].profileId;
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const b = S().newTab(w, { url: "https://b.com/", background: true });
  S().switchProfile(w, home);
  const now = Date.now();
  S().updateTab(b, { lastActiveAt: now - 25 * MIN });
  S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 30 });
  assert.equal(nextAutoCleanUpAt(S(), now), now + 5 * MIN);
});

test("with tabs shared across windows, the sweep of a window holding the profile hidden keeps the tab another window shows", () => {
  const [w, a] = windowWith("a", "b");
  S().updateSettings({ shareTabsAcrossWindows: true });
  const other = S().createWindow();
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(other, work);
  const longAgo = Date.now() - 13 * 60 * MIN;
  for (const t of Object.values(S().tabs)) if (t.url === "https://a.com/") S().updateTab(t.id, { lastActiveAt: longAgo });
  S().cleanUpTabs(other, { inactiveForMs: 12 * 60 * MIN, allProfiles: true });
  assert.ok(S().tabs[a], "the tab on screen in the first window stays");
  assert.equal(model.activeTabId(S(), w), a);
});

test("with tabs shared across windows, a tab just left in one window keeps its full idle time in a window holding the profile hidden", () => {
  const [w, a, b] = windowWith("a", "b");
  S().updateSettings({ shareTabsAcrossWindows: true });
  const other = S().createWindow();
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(other, work);
  const longAgo = Date.now() - 13 * 60 * MIN;
  for (const t of Object.values(S().tabs)) if (t.url === "https://a.com/") S().updateTab(t.id, { lastActiveAt: longAgo });
  S().activate(b);
  noteDeselectedTabs(S(), [a]);
  for (const id of S().windowOrder) S().cleanUpTabs(id, { inactiveForMs: 12 * 60 * MIN, allProfiles: true });
  assert.ok(S().tabs[a], "the tab left a moment ago stays");
  assert.equal(model.activeTabId(S(), w), b);
});

test("a tab left while tabs were shared keeps its full idle time after sharing is turned off, also when the copy kept is not the one that was left", () => {
  const [w, a, b] = windowWith("a", "b");
  S().updateSettings({ shareTabsAcrossWindows: true });
  const other = S().createWindow();
  S().activate(b);
  const longAgo = Date.now() - 13 * 60 * MIN;
  for (const t of Object.values(S().tabs)) if (t.url === "https://a.com/") S().updateTab(t.id, { lastActiveAt: longAgo });
  const copy = Object.values(S().tabs).find((t) => t.url === "https://a.com/" && t.windowId === other);
  noteDeselectedTabs(S(), [copy.id]);
  S().updateSettings({ shareTabsAcrossWindows: false });
  assert.ok(S().tabs[a] && !S().tabs[copy.id], "turning sharing off kept the copy that wasn't left");
  assert.deepEqual(cleanUpCandidates(S(), w, 12 * 60 * MIN).filter((id) => id === a), []);
});

function hiddenIdleTabs(w, prefix, count, idleSince) {
  const home = S().windows[w].profileId;
  const work = Object.values(S().profiles).find((p) => p.name === "Work")?.id ?? S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const ids = Array.from({ length: count }, (_, i) => S().newTab(w, { url: `https://${prefix}-${i}.com/`, background: true }));
  S().switchProfile(w, home);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: idleSince - i * MIN }));
  return ids;
}

function onScreenIdleTabs(w, prefix, count, idleSince) {
  const ids = Array.from({ length: count }, (_, i) => S().newTab(w, { url: `https://${prefix}-${i}.com/`, background: true }));
  ids.forEach((id) => S().updateTab(id, { lastActiveAt: idleSince }));
  return ids;
}

const DAY = 24 * 60 * MIN;

function olderEntries(w, count, listedFor = 0) {
  onScreenIdleTabs(w, "old", count, Date.now() - 13 * 60 * MIN);
  S().cleanUpTabs(w, { inactiveForMs: 12 * 60 * MIN });
  assert.equal(S().cleanedTabs.length, count);
  useBrowser.setState({ cleanedTabs: S().cleanedTabs.map((c) => ({ ...c, closedAt: c.closedAt - listedFor })) });
}

function countSweeps() {
  const real = S().cleanUpTabs;
  const at = new Set();
  useBrowser.setState({ cleanUpTabs: (windowId, options) => (at.add(Date.now()), real(windowId, options)) });
  return at;
}

const closedAndListed = (ids) => {
  const listed = new Set(S().cleanedTabs.map((c) => c.tabId));
  const closed = ids.filter((id) => !S().tabs[id]);
  return { closed: closed.length, unlisted: closed.filter((id) => !listed.has(id)).length };
};

test("one automatic sweep closes in hidden profiles at most the day-old entries it may replace less what it closed on screen, longest idle first across windows", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w1] = windowWith("a");
    olderEntries(w1, 100, DAY);
    const w2 = S().createWindow({ url: "https://z.com/" });
    const onScreen = onScreenIdleTabs(w1, "on", 30, Date.now() - 13 * 60 * MIN);
    const one = hiddenIdleTabs(w1, "one", 50, Date.now() - 13 * 60 * MIN);
    const two = hiddenIdleTabs(w2, "two", 50, Date.now() - 20 * 60 * MIN);
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 720 });
    t.mock.timers.tick(1000);
    assert.deepEqual(closedAndListed(onScreen), { closed: 30, unlisted: 0 });
    assert.deepEqual(closedAndListed([...one, ...two]), { closed: 70, unlisted: 0 }, "100 less the 30 closed on screen");
    assert.ok(two.every((id) => !S().tabs[id]), "the other window's longer idle tabs go first");
    assert.ok(one.slice(-20).every((id) => !S().tabs[id]) && one.slice(0, 30).every((id) => S().tabs[id]), "then this window's longest idle");
    assert.equal(S().cleanedTabs.filter((c) => /old-/.test(c.tab.url)).length, 0, "the day-old entries made the room");
  } finally {
    stopAutoCleanUp();
  }
});

test("nothing an automatic sweep closes on screen and in hidden profiles across windows is pushed out of Recently Cleaned by the same sweep", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w1] = windowWith("a");
    olderEntries(w1, 40, DAY);
    const w2 = S().createWindow({ url: "https://z.com/" });
    const w3 = S().createWindow({ url: "https://y.com/" });
    const idle = Date.now() - 13 * 60 * MIN;
    const hidden = [...hiddenIdleTabs(w1, "one", 60, idle), ...hiddenIdleTabs(w3, "three", 20, idle)];
    const onScreen = [...onScreenIdleTabs(w2, "on", 50, idle), ...onScreenIdleTabs(w3, "on3", 10, idle)];
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 720 });
    t.mock.timers.tick(1000);
    assert.deepEqual(closedAndListed(onScreen), { closed: 60, unlisted: 0 });
    assert.deepEqual(closedAndListed(hidden), { closed: 40, unlisted: 0 });
  } finally {
    stopAutoCleanUp();
  }
});

test("with no room for hidden-profile tabs past their time, clean-up looks again at the recheck, never every second", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w1] = windowWith("a");
    olderEntries(w1, 100);
    const hidden = hiddenIdleTabs(w1, "one", 10, Date.now() - 13 * 60 * MIN);
    const sweeps = countSweeps();
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 720 });
    for (let i = 0; i < 3 * 60 * 60; i++) t.mock.timers.tick(1000);
    assert.equal(closedAndListed(hidden).closed, 0, "no entry is a day old yet");
    assert.ok(sweeps.size <= 7, `${sweeps.size} sweeps in three hours`);
  } finally {
    stopAutoCleanUp();
  }
});

test("a backlog of 250 hidden-profile tabs closes 100 at first, then waits until those entries are a day old before replacing them", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w1] = windowWith("a");
    const hidden = hiddenIdleTabs(w1, "one", 250, Date.now() - 13 * 60 * MIN);
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 720 });
    t.mock.timers.tick(1000);
    const first = new Map(S().cleanedTabs.map((c) => [c.id, c.closedAt]));
    assert.equal(first.size, 100);
    for (let i = 0; i < 2 * 60 * 60; i++) t.mock.timers.tick(1000);
    assert.deepEqual(closedAndListed(hidden), { closed: 100, unlisted: 0 });
    assert.deepEqual(S().cleanedTabs.map((c) => c.id), [...first.keys()], "everything the first sweep listed is still listed");
    let replacedAt = null;
    for (let i = 0; i < 23 * 60 && replacedAt === null; i++) {
      t.mock.timers.tick(MIN);
      if (S().cleanedTabs.some((c) => !first.has(c.id))) replacedAt = Date.now();
    }
    assert.ok(replacedAt !== null, "the next batch closes after a day");
    assert.deepEqual(closedAndListed(hidden), { closed: 200, unlisted: 100 }, "the second batch is listed in place of the first");
    assert.ok(S().cleanedTabs.every((c) => !first.has(c.id)));
    assert.ok([...first.values()].every((closedAt) => replacedAt - closedAt >= DAY), "only entries listed a day ago were pushed out");
  } finally {
    stopAutoCleanUp();
  }
});

test("with tabs shared across windows and a profile hidden in every window, the tab each window remembers for it stays", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w1] = windowWith("x", "y", "z");
    const home = S().windows[w1].profileId;
    S().updateSettings({ shareTabsAcrossWindows: true });
    const w2 = S().createWindow();
    const copyIn = (w, url) => Object.values(S().tabs).find((x) => x.url === url && x.windowId === w)?.id;
    S().activate(copyIn(w1, "https://x.com/"));
    S().activate(copyIn(w2, "https://y.com/"));
    const work = S().createProfile({ name: "Work" });
    S().switchProfile(w1, work);
    S().switchProfile(w2, work);
    const longAgo = Date.now() - 13 * 60 * MIN;
    for (const x of Object.values(S().tabs)) if (/[xyz]\.com/.test(x.url)) S().updateTab(x.id, { lastActiveAt: longAgo });
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 720 });
    t.mock.timers.tick(1000);
    for (const w of [w1, w2]) assert.ok(copyIn(w, "https://x.com/") && copyIn(w, "https://y.com/") && !copyIn(w, "https://z.com/"));
    S().switchProfile(w1, home);
    S().switchProfile(w2, home);
    assert.equal(S().tabs[model.activeTabId(S(), w1)].url, "https://x.com/");
    assert.equal(S().tabs[model.activeTabId(S(), w2)].url, "https://y.com/");
  } finally {
    stopAutoCleanUp();
  }
});

test("with tabs shared across windows, a window holding a profile hidden never closes a tab another window has on screen, duplicates included", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const [w1, a, one] = windowWith("a", "doc-one");
    S().updateSettings({ shareTabsAcrossWindows: true });
    S().updateTab(one, { url: "https://doc.com/#one" });
    S().newTab(w1, { url: "https://doc.com/#two", background: true });
    const w2 = S().createWindow();
    S().activate(one);
    S().createSplit([one, a]);
    S().switchProfile(w1, S().createProfile({ name: "Work" }));
    const docsIn = (w) => model.viewTabIds(S(), w).filter((id) => S().tabs[id].url.startsWith("https://doc.com/"));
    assert.equal(docsIn(w2).length, 1, "the other window has the page on screen");
    startAutoCleanUp();
    S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 720 });
    t.mock.timers.tick(31 * MIN);
    assert.equal(docsIn(w2).length, 1, "the page stays on screen there");
    assert.ok(S().tabs[one], "the tab the hidden profile remembers stays");
  } finally {
    stopAutoCleanUp();
  }
});

test("with tabs shared across windows, a tab only a window holding its profile hidden remembers is cleaned up by the window that shows the profile", () => {
  const [w, , b] = windowWith("a", "b");
  S().updateSettings({ shareTabsAcrossWindows: true });
  const other = S().createWindow();
  const aIn = (windowId) => Object.values(S().tabs).find((x) => x.url === "https://a.com/" && x.windowId === windowId)?.id;
  S().activate(b);
  S().activate(aIn(other));
  const home = S().windows[w].profileId;
  S().switchProfile(other, S().createProfile({ name: "Work" }));
  const longAgo = Date.now() - 13 * 60 * MIN;
  for (const x of Object.values(S().tabs)) if (x.url === "https://a.com/") S().updateTab(x.id, { lastActiveAt: longAgo });
  assert.equal(S().windows[other].activeTabIds[home], aIn(other), "the other window remembers it for the profile it isn't showing");
  assert.deepEqual(cleanUpCandidates(S(), w, 12 * 60 * MIN), [aIn(w)], "the first window cleans it up");
  assert.deepEqual(cleanUpCandidates(S(), other, 12 * 60 * MIN, undefined, home), [], "the window holding the profile hidden leaves it to the window that shows it");
});
