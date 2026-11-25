import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { updateLive } = await import("../tabs/actions.ts");
const { liveOf, onLiveChange } = await import("../tabs/tabLive.ts");
const { endThemeHold, heldThemeColor, COMMIT_THEME_HOLD_MS } = await import("./launchLook.ts");

const S = () => useBrowser.getState();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function tabShowing(color) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://blue.example/one" });
  const tab = S().windows[w].tabIds[0];
  updateLive(tab, { themeColor: color });
  const changes = [];
  const stop = onLiveChange((id, live, prev) => {
    if (id === tab && live.themeColor !== prev.themeColor) changes.push(live.themeColor);
  });
  const navigate = (url, reported, isLoading = false) => updateLive(tab, { themeColor: heldThemeColor(tab, url, reported, isLoading) });
  return { tab, changes, navigate, stop };
}

test("a commit that reports no theme colour before the page's own makes no store update when the colour is the same", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://blue.example/two", null, true);
  await sleep(8);
  t.navigate("https://blue.example/two", "#336699", true);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(t.changes, [], "no flash: the tint never drops");
  assert.equal(liveOf(t.tab).themeColor, "#336699");
  t.stop();
});

test("a page of another colour changes the tint once, not twice", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://red.example/", null, true);
  await sleep(8);
  t.navigate("https://red.example/", "#993333", true);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(t.changes, ["#993333"]);
  t.stop();
});

test("a page with no theme colour clears the tint once the hold ends, and not before", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://plain.example/", null, true);
  t.navigate("https://plain.example/", null, false);
  assert.equal(liveOf(t.tab).themeColor, "#336699", "held through the commit");
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(liveOf(t.tab).themeColor, null, "cleared one beat later");
  assert.deepEqual(t.changes, [null]);
  t.navigate("https://plain.example/next", null, false);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(t.changes, [null], "an uncoloured page after an uncoloured one holds nothing");
  t.stop();
});

test("a tab closed during the hold is left alone", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://plain.example/", null, true);
  S().closeTab(t.tab);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(S().tabs[t.tab], undefined);
  t.stop();
});

test("a tab switch during the hold still clears an uncoloured page's tint on time", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://plain.example/", null, true);
  const other = S().createWindow({ url: "https://other.example/" });
  S().activate(S().windows[other].tabIds[0]);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(liveOf(t.tab).themeColor, null, "the hold never sticks on a tab that is no longer shown");
  assert.deepEqual(t.changes, [null]);
  t.stop();
});

test("a navigation that fails or is cancelled clears within the hold, or keeps the page's colour when the old page stays", async () => {
  const failed = tabShowing("#336699");
  failed.navigate("https://unreachable.example/", null, true);
  failed.navigate("https://unreachable.example/", null, false);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(liveOf(failed.tab).themeColor, null, "an error page without a theme colour clears");
  failed.stop();
  const cancelled = tabShowing("#336699");
  cancelled.navigate("https://blue.example/one", null, true);
  cancelled.navigate("https://blue.example/one", "#336699", false);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(cancelled.changes, [], "the old page stays, its colour stays, no update");
  cancelled.stop();
});

test("a differently coloured page arriving after the hold shows white for no longer than the hold", async () => {
  const t = tabShowing("#336699");
  const started = Date.now();
  t.navigate("https://slow.example/", null, true);
  await sleep(COMMIT_THEME_HOLD_MS + 30);
  t.navigate("https://slow.example/", "#993333", false);
  assert.ok(Date.now() - started >= COMMIT_THEME_HOLD_MS);
  assert.deepEqual(t.changes, [null, "#993333"], "only a colour later than the hold shows the uncoloured toolbar between");
  t.stop();
});

test("unmounting the page or closing the tab ends the hold at once and leaves no timer behind", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://plain.example/", null, true);
  endThemeHold(t.tab);
  assert.equal(liveOf(t.tab).themeColor, null, "an unmounted page clears its held tint immediately");
  updateLive(t.tab, { themeColor: "#123456" });
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(liveOf(t.tab).themeColor, "#123456", "no timer from the ended hold fires later");
  const closed = tabShowing("#336699");
  closed.navigate("https://plain.example/", null, true);
  S().closeTab(closed.tab);
  endThemeHold(closed.tab);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(S().tabs[closed.tab], undefined);
  t.stop();
  closed.stop();
});

test("the web view ends its tab's hold when it unmounts", () => {
  const source = readFileSync(new URL("../../components/window/TabWebView.tsx", import.meta.url), "utf8");
  assert.match(source, /noteGone\(tabId\);\n\s*endThemeHold\(tabId\);/);
});
