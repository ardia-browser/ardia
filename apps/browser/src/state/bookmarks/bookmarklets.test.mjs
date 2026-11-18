import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openUrl, openLinks } = await import("./actions.ts");
const { runCommand } = await import("../commands/commands.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { bookmarkUrlFrom, runBookmarklet } = await import("./bookmarklets.ts");

const S = () => useBrowser.getState();
const SAKURA = "javascript:(function(){var l=document.createElement('link');l.rel='stylesheet';l.href='https://oxal.org/projects/sakura/sakura.css';document.head.appendChild(l);})()";
const SEARCH = "https://www.google.com/search?q=";

function watch(tabId) {
  const loads = [];
  webviews.set(tabId, { loadUrl: (u, options) => void loads.push([u, options]) });
  return loads;
}

function seed(url) {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  const windowId = S().createWindow({ url });
  const tabId = S().windows[windowId].tabIds[0];
  return { windowId, tabId, loads: watch(tabId) };
}

test("a bookmarklet typed into the bookmark editor is saved as itself, not as a search for its code", () => {
  assert.equal(bookmarkUrlFrom(`  ${SAKURA} `, SEARCH), SAKURA);
  assert.equal(bookmarkUrlFrom("JavaScript:alert(1)", SEARCH), "JavaScript:alert(1)");
  assert.equal(bookmarkUrlFrom("example.com", SEARCH), "https://example.com");
  assert.equal(bookmarkUrlFrom("   ", SEARCH), "");
});

test("opening a bookmarklet runs it in the page the window shows instead of navigating anywhere", () => {
  const { windowId, tabId, loads } = seed("https://example.com/");
  for (const mode of ["current", "background", "foreground", "window", "split"]) openUrl(SAKURA, windowId, mode);
  assert.deepEqual(loads.map(([u]) => u), Array(5).fill(SAKURA));
  assert.ok(loads.every(([, options]) => options.userInitiated));
  assert.equal(S().tabs[tabId].url, "https://example.com/");
  assert.equal(S().windowOrder.length, 1, "no window opens for a bookmarklet");
  assert.equal(S().windows[windowId].tabIds.length, 1, "no tab opens for a bookmarklet");
  webviews.delete(tabId);
});

test("the Bookmarks menu runs a bookmarklet on the page the command targets, not on the tab behind it", () => {
  const { windowId, tabId, loads } = seed("https://example.com/");
  const other = S().newTab(windowId, { url: "https://other.example/", background: true });
  const otherLoads = watch(other);
  const id = S().addBookmark({ profileId: "default", url: SAKURA, title: "sakura" });
  runCommand({ command: "openBookmark", arg: id, windowId }, { tabId: other });
  assert.deepEqual(otherLoads.map(([u]) => u), [SAKURA]);
  assert.deepEqual(loads, []);
  assert.equal(runBookmarklet(SAKURA, windowId, other), true);
  assert.equal(otherLoads.length, 2);
  assert.deepEqual(loads, []);
  webviews.delete(tabId);
  webviews.delete(other);
});

test("a bookmarklet does nothing on a page that isn't a web page, and Open All skips it", async () => {
  const { windowId, tabId, loads } = seed("ardia://history");
  assert.equal(runBookmarklet(SAKURA, windowId), false);
  await openLinks([{ url: SAKURA }], windowId);
  assert.deepEqual(loads, []);
  assert.equal(S().windows[windowId].tabIds.length, 1);
  webviews.delete(tabId);
});
