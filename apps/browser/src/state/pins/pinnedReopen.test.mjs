import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { reopensAtPinnedUrl } = await import("./pinHomes.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { userClose } = await import("../tabs/closeActivation.ts");
const { tabMenuItems } = await import("../sidebar/tabMenu.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { sameAddress } = await import("../../lib/url.ts");

const S = () => useBrowser.getState();
setConsentPeriod(true, "sharing-on");
const HOME = "https://app.example.com/#/home";
const AWAY = "https://app.example.com/#/settings";

function pinnedAt(home, now) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const p = S().newTab(w, { url: home });
  S().togglePin(p);
  S().activate(p);
  assert.equal(S().tabs[p].pinnedUrl, home);
  S().updateTab(p, { url: now, title: "Settings" });
  return { w, p };
}

const closePinned = (p) => {
  takeTabSleepCounts();
  S().closeTab(p);
  return S().tabs[p];
};

const customizeItems = (w, p) => tabMenuItems(S(), w, S().tabs[p]).find((i) => i.id === "customize").children;

test("a pinned tab on another hash route goes back to its pinned URL when closed, as Discord's repro asked", () => {
  const { p } = pinnedAt(HOME, AWAY);
  const tile = closePinned(p);
  assert.equal(tile.url, HOME);
  assert.equal(tile.pinnedUrl, HOME);
  assert.equal(tile.page.kind, "asleep");
  assert.equal(tile.page.wake, undefined, "no restore of the old history: it loads the pinned URL fresh");
  assert.equal(takeTabSleepCounts().pinned_closes_back_to_pinned_url, 1);
});

test("with Reopen closed pinned tabs at their pinned URL off, it keeps the page it showed", () => {
  const { p } = pinnedAt(HOME, AWAY);
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    const tile = closePinned(p);
    assert.equal(tile.url, AWAY);
    assert.equal(tile.pinnedUrl, HOME, "its pinned URL is unchanged");
    const counts = takeTabSleepCounts();
    assert.equal(counts.pinned_closes_kept_last_page, 1);
    assert.equal(counts.pinned_closes_back_to_pinned_url, 0);
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
});

test("one pinned tab's own choice wins over the setting, both ways, from its Customize menu", () => {
  const { w, p } = pinnedAt(HOME, AWAY);
  const item = () => customizeItems(w, p).find((i) => i.id === "reopenAtPin");
  assert.equal(item().checked, true);
  assert.equal(item().title, "Reopen at Pinned URL");
  S().updateTab(p, { reopenAtPinnedUrl: false });
  assert.equal(item().checked, false);
  assert.equal(closePinned(p).url, AWAY, "kept its last page although the setting is on");

  const second = pinnedAt(HOME, AWAY);
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    S().updateTab(second.p, { reopenAtPinnedUrl: true });
    assert.equal(reopensAtPinnedUrl(S().settings, S().tabs[second.p]), true);
    assert.equal(closePinned(second.p).url, HOME, "went home although the setting is off");
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
});

test("a regular tab's menu has no Reopen at Pinned URL", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const t = model.viewTabIds(S(), w)[0];
  assert.equal(customizeItems(w, t).some((i) => i.id === "reopenAtPin"), false);
});

test("a second window's copy of the pinned tab carries its own choice", () => {
  const { p } = pinnedAt(HOME, AWAY);
  S().updateTab(p, { reopenAtPinnedUrl: false });
  const n = S().createWindow();
  const copy = model.viewTabIds(S(), n).map((id) => S().tabs[id]).find((t) => t.pinnedUrl === HOME);
  assert.ok(copy, "the pinned tab is mirrored");
  assert.equal(copy.reopenAtPinnedUrl, false);
});

test("addresses that differ only in their fragment are different addresses, a trailing slash is not", () => {
  assert.equal(sameAddress(HOME, AWAY), false);
  assert.equal(sameAddress("https://a.com/", "https://a.com"), true);
  assert.equal(sameAddress("https://a.com/x#", "https://a.com/x"), true);
  assert.equal(sameAddress("https://a.com/x#top", "https://a.com/x#top"), true);
});

const offWhile = (fn) => {
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    return fn();
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
};

test("a close chosen while sharing was off isn't counted after sharing turns on, one chosen while on is", () => {
  const { p } = pinnedAt(HOME, AWAY);
  setConsentPeriod(false, null);
  const before = consentToken();
  setConsentPeriod(true, "sharing-on-later");
  takeTabSleepCounts();
  offWhile(() => S().closeTabs([p], userClose([p], { consent: before }, { keepTopApps: false })));
  const missed = takeTabSleepCounts();
  assert.equal(missed.pinned_closes_kept_last_page, 0, "the menu opened with sharing off");
  assert.equal(missed.pinned_closes_back_to_pinned_url, 0);

  const second = pinnedAt(HOME, AWAY);
  const now = consentToken();
  takeTabSleepCounts();
  offWhile(() => S().closeTabs([second.p], userClose([second.p], { consent: now }, { keepTopApps: false })));
  assert.equal(takeTabSleepCounts().pinned_closes_kept_last_page, 1);
  setConsentPeriod(true, "sharing-on");
});

function twoPins({ off = false, away = AWAY } = {}) {
  S().hydrate({});
  if (off) S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  const w = S().createWindow({ url: "https://a.com" });
  const p = S().newTab(w, { url: HOME });
  const other = S().newTab(w, { url: "https://mail.example.com/" });
  S().togglePin(p);
  S().togglePin(other);
  S().activate(p);
  S().updateTab(p, { url: away, title: "Settings" });
  return { w, p, other };
}

test("with it off, renaming another pin in a second window keeps the closed pin's last page", () => {
  offWhile(() => {
    const away = "https://app.example.com/settings";
    const { p, other } = twoPins({ off: true, away });
    S().closeTab(p);
    assert.equal(S().tabs[p].url, away);
    const n = S().createWindow();
    const otherCopy = model.viewTabIds(S(), n).find((id) => S().tabs[id].pinnedUrl === S().tabs[other].pinnedUrl);
    S().updateTab(otherCopy, { customTitle: "Inbox" });
    assert.equal(S().tabs[other].customTitle, "Inbox", "the rename reached the first window");
    assert.equal(S().tabs[p].url, away, "and left the sleeping pin on its last page");
    assert.equal(S().tabs[p].pinnedUrl, HOME);
  });
});

test("with it on, the same rename still sends a sleeping pin that strayed home", () => {
  const { p, other } = twoPins({ away: "https://app.example.com/settings" });
  S().updateTab(p, { page: { kind: "asleep" } });
  const n = S().createWindow();
  const otherCopy = model.viewTabIds(S(), n).find((id) => S().tabs[id].pinnedUrl === S().tabs[other].pinnedUrl);
  S().updateTab(otherCopy, { customTitle: "Inbox" });
  assert.equal(S().tabs[p].url, HOME);
});

test("with it off, closing the pin's last window parks it on its last page and the next window gets that page back", () => {
  offWhile(() => {
    const { w, p } = twoPins({ off: true });
    S().closeWindow(w);
    const parked = S().parkedPins.default.tabs.find((t) => t.pinnedUrl === HOME);
    assert.ok(parked, "parked");
    assert.equal(parked.url, AWAY);
    const n = S().createWindow();
    const back = model.viewTabIds(S(), n).map((id) => S().tabs[id]).find((t) => t.pinnedUrl === HOME);
    assert.equal(back.url, AWAY);
    assert.ok(p);
  });
});

test("with it on, parking still takes the pin home, hash routes included", () => {
  const { w } = twoPins();
  S().closeWindow(w);
  assert.equal(S().parkedPins.default.tabs.find((t) => t.pinnedUrl === HOME).url, HOME);
});

const copyIn = (windowId, home) => model.viewTabIds(S(), windowId).find((id) => S().tabs[id].pinnedUrl === home);
const navUrl = (id) => S().tabs[id].page.nav?.url;
const shownUrl = (id) => {
  const page = S().tabs[id].page;
  return page.kind === "frozen" ? S().tabs[page.holderId].url : page.nav?.url;
};

test("with it off, closing a pin on another route lets its sleeping copy in a second window open that route, and reopening it in the first keeps it", () => {
  pinnedAt(HOME, AWAY);
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    const first = S().windowOrder[0];
    const p = copyIn(first, HOME);
    const second = S().createWindow();
    const copy = copyIn(second, HOME);
    assert.equal(S().tabs[copy].page.kind, "asleep");
    S().closeTab(p);
    assert.equal(S().tabs[p].url, AWAY);
    assert.equal(S().tabs[copy].url, AWAY, "the sleeping copy takes the kept route");
    S().activate(copy);
    assert.equal(S().tabs[copy].url, AWAY);
    assert.equal(navUrl(copy), AWAY, "and opens it");
    S().activate(p);
    assert.equal(S().tabs[p].url, AWAY, "reopening it in the first window keeps the route");
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
});

test("a hash-only pinned URL edit moves a sleeping copy to the new route, and it opens there", () => {
  const { p } = pinnedAt(HOME, HOME);
  const first = S().windowOrder[0];
  const second = S().createWindow();
  const copy = copyIn(second, HOME);
  S().closeTab(p);
  assert.equal(S().tabs[copy].page.kind, "asleep");
  assert.equal(S().tabs[p].page.kind, "asleep");
  S().setPinnedUrl(p, AWAY);
  assert.equal(navUrl(p), AWAY, "the edited tab navigates to the new route, though only the fragment changed");
  S().updateTab(p, { url: AWAY });
  assert.equal(S().tabs[copy].pinnedUrl, AWAY);
  assert.equal(S().tabs[copy].url, AWAY, "the copy moved with the edit");
  S().activate(copy);
  assert.equal(shownUrl(copy), AWAY, "and opens the new route");
  assert.ok(first);
});

test("with it off, closing the pin again back at its pinned URL brings the sleeping copy home too", () => {
  pinnedAt(HOME, AWAY);
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    const first = S().windowOrder[0];
    const p = copyIn(first, HOME);
    const second = S().createWindow();
    const copy = copyIn(second, HOME);
    S().closeTab(p);
    assert.equal(S().tabs[copy].url, AWAY);
    S().activate(p);
    S().updateTab(p, { url: HOME, title: "Home" });
    S().closeTab(p);
    assert.equal(S().tabs[p].url, HOME);
    assert.equal(S().tabs[copy].url, HOME, "the copy follows the page it was last closed on, home included");
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
});

test("with it off, a window opened after the close starts its copy on the kept page", () => {
  const { p } = pinnedAt(HOME, AWAY);
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    S().closeTab(p);
    const later = S().createWindow();
    const copy = copyIn(later, HOME);
    assert.ok(copy, "the new window has the pin");
    assert.equal(S().tabs[copy].url, AWAY);
    assert.equal(S().tabs[copy].page.kind, "asleep");
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
});

test("with it on, a window opened after the close starts its copy at the pinned URL", () => {
  const { p } = pinnedAt(HOME, AWAY);
  S().closeTab(p);
  const later = S().createWindow();
  assert.equal(S().tabs[copyIn(later, HOME)].url, HOME);
});

test("a hash-only pinned URL edit on a pinned group's tab moves its sleeping copy in another window to the new route", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const member = S().newTab(w, { url: HOME });
  const neighbour = S().newTab(w, { url: "https://wiki.example.com/" });
  const group = S().groupTabs([member, neighbour], { pinned: true });
  S().updateGroup(group, { name: "Work" });
  assert.equal(S().tabs[member].pinnedUrl, HOME);
  const second = S().createWindow();
  const copy = copyIn(second, HOME);
  assert.ok(copy, "the pinned group is mirrored");
  assert.notEqual(copy, member);
  assert.equal(S().tabs[copy].page.kind, "asleep");
  S().setPinnedUrl(member, AWAY);
  S().updateTab(member, { url: AWAY });
  assert.equal(S().tabs[copy].pinnedUrl, AWAY);
  assert.equal(S().tabs[copy].url, AWAY, "the sleeping copy moved with the edit");
  S().activate(copy);
  assert.equal(shownUrl(copy), AWAY, "and opens the new route");
});

test("a sleeping copy that takes the kept page drops the history it would have restored, so it opens that page", () => {
  pinnedAt(HOME, AWAY);
  const p = copyIn(S().windowOrder[0], HOME);
  const second = S().createWindow();
  const copy = copyIn(second, HOME);
  assert.equal(S().tabs[copy].url, HOME);
  S().updateSettings({ pinnedTabsReopenAtPinnedUrl: false });
  try {
    S().updateTab(copy, { page: { kind: "asleep", wake: `restore:${copy}` } });
    S().closeTab(p);
    assert.equal(S().tabs[copy].url, AWAY);
    assert.equal(S().tabs[copy].page.wake, undefined, "its own old entry isn't restored");
    S().activate(copy);
    assert.equal(shownUrl(copy), AWAY);
  } finally {
    S().updateSettings({ pinnedTabsReopenAtPinnedUrl: true });
  }
});

test("a sleeping copy a hash-only edit moves drops the history it would have restored", () => {
  const { p } = pinnedAt(HOME, HOME);
  const second = S().createWindow();
  const copy = copyIn(second, HOME);
  S().closeTab(p);
  S().updateTab(copy, { page: { kind: "asleep", wake: `restore:${copy}` } });
  S().setPinnedUrl(p, AWAY);
  S().updateTab(p, { url: AWAY });
  assert.equal(S().tabs[copy].url, AWAY);
  assert.equal(S().tabs[copy].page.wake, undefined);
});
