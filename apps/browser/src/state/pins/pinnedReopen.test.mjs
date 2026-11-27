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
