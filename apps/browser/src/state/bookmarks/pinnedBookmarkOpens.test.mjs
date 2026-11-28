import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { openBookmark, openModeFor } = await import("./actions.ts");
const { runCommand } = await import("../commands/commands.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { takeBookmarkletCounts } = await import("../telemetry/bookmarkletCounts.ts");
const { navigationOf } = await import("../tabs/pageSession.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
setConsentPeriod(true, "sharing-on");
const YOUTUBE = "https://www.youtube.com/";
const CLAUDE = "https://claude.ai/";

function onTopApp() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const tile = S().newTab(w, { url: YOUTUBE });
  S().togglePin(tile);
  S().activate(tile);
  assert.ok(S().tabs[tile].pin, "the tab is a Top App");
  takeBookmarkletCounts();
  return { w, tile };
}

const keptPinnedTab = () => takeBookmarkletCounts().bookmarks_kept_pinned_tab;

test("a plain click on a bookmark while a Top App is shown opens a new tab and leaves the Top App on its page", () => {
  const { w, tile } = onTopApp();
  const before = S().windows[w].tabIds.length;
  openBookmark(CLAUDE, w, openModeFor({}), consentToken());
  assert.equal(S().tabs[tile].url, YOUTUBE);
  assert.equal(S().windows[w].tabIds.length, before + 1);
  const opened = activeTabId(S(), w);
  assert.notEqual(opened, tile);
  assert.equal(S().tabs[opened].url, CLAUDE);
  assert.ok(!S().tabs[opened].pin);
  assert.equal(keptPinnedTab(), 1);
});

test("a plain click on a bookmark in a regular tab still loads it in that tab", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const tab = activeTabId(S(), w);
  takeBookmarkletCounts();
  const before = S().windows[w].tabIds.length;
  openBookmark(CLAUDE, w, openModeFor({}), consentToken());
  assert.equal(S().windows[w].tabIds.length, before);
  assert.equal(activeTabId(S(), w), tab);
  assert.equal(navigationOf(S().tabs[tab])?.url, CLAUDE);
  assert.equal(keptPinnedTab(), 0);
});

test("a ⌘-click on a bookmark from a Top App still opens it behind, without counting a kept pin", () => {
  const { w, tile } = onTopApp();
  openBookmark(CLAUDE, w, openModeFor({ metaKey: true }), consentToken());
  assert.equal(activeTabId(S(), w), tile);
  assert.equal(S().tabs[tile].url, YOUTUBE);
  assert.ok(Object.values(S().tabs).some((t) => t.url === CLAUDE && !t.pin));
  assert.equal(keptPinnedTab(), 0);
});

test("a bookmark picked from the Bookmarks menu while a Top App is shown opens a new tab too", () => {
  const { w, tile } = onTopApp();
  const id = S().addBookmark({ profileId: S().windows[w].profileId, url: CLAUDE, title: "Claude" });
  runCommand({ command: "openBookmark", arg: id, windowId: w }, { user: { consent: consentToken() } });
  assert.equal(S().tabs[tile].url, YOUTUBE);
  const opened = activeTabId(S(), w);
  assert.notEqual(opened, tile);
  assert.equal(S().tabs[opened].url, CLAUDE);
  assert.equal(keptPinnedTab(), 1);
});

test("a bookmark that opens outside a tab doesn't count as keeping the Top App", () => {
  const { w, tile } = onTopApp();
  const before = Object.keys(S().tabs).length;
  openBookmark("ardia://settings", w, openModeFor({}), consentToken());
  assert.equal(S().tabs[tile].url, YOUTUBE);
  assert.equal(Object.keys(S().tabs).length, before);
  assert.equal(keptPinnedTab(), 0);
});

test("a bookmarklet clicked on a Top App still runs in that tab and opens no new one", () => {
  const { w, tile } = onTopApp();
  const loads = [];
  webviews.set(tile, { loadUrl: (u) => void loads.push(u) });
  const before = S().windows[w].tabIds.length;
  const BOOKMARKLET = "javascript:void(document.title='ran')";
  openBookmark(BOOKMARKLET, w, openModeFor({}), consentToken());
  webviews.delete(tile);
  assert.deepEqual(loads, [BOOKMARKLET]);
  assert.equal(S().windows[w].tabIds.length, before);
  assert.equal(activeTabId(S(), w), tile);
  assert.equal(keptPinnedTab(), 0);
});
