import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { reopensAtPinnedUrl } = await import("./organize.ts");
const { tabMenuItems } = await import("../sidebar/tabMenu.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { sameAddress } = await import("../../lib/url.ts");

const S = () => useBrowser.getState();
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
    assert.equal(reopensAtPinnedUrl(S(), S().tabs[second.p]), true);
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
