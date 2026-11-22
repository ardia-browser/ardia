import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../../state/telemetry/client.ts");
const usage = await import("../../state/telemetry/usage.ts");
const { useBrowser } = await import("../../state/browser/store.ts");
const { showsEmptyWindow } = await import("../../state/browser/model.ts");
const { emptyWindowPeekCount } = await import("./useEmptyWindowPeek.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const empty = (w) => showsEmptyWindow(S(), w);
const setPage = (id, page) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], page } } }));
const setUrl = (id, url) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], url } } }));

async function emptyWindowPeeks() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts") : [];
  return events.reduce((n, e) => n + (e.properties.sidebar_empty_window_peeks ?? 0), 0);
}

test("a window is empty while it holds nothing but New Tabs and sleeping tabs, not while a page is still open in it", () => {
  S().hydrate({});
  S().updateSettings({ newTabOpens: "page" });
  const w = S().createWindow();
  const first = S().windows[w].tabIds[0];
  assert.equal(empty(w), true, "a new window on its New Tab");

  setUrl(first, "https://a.com/");
  assert.equal(empty(w), false, "the New Tab went to a page");

  const typed = S().newTab(w, { newTabCommand: true });
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], typed);
  assert.equal(empty(w), false, "⌘T beside an open page");

  S().activate(first);
  S().activate(typed);
  assert.equal(empty(w), false, "switching to a New Tab while a page is open");

  setPage(first, { kind: "asleep" });
  assert.equal(empty(w), true, "the only page went to sleep, so nothing is open");

  setPage(first, { kind: "idle" });
  assert.equal(empty(w), false, "a page restored at launch is still open");

  S().activate(first);
  assert.equal(empty(w), false, "a page is shown");
});

test("closing the last open page beside sleeping pinned tabs leaves an empty window on a New Tab", () => {
  S().hydrate({});
  S().updateSettings({ newTabOpens: "page" });
  const w = S().createWindow({ url: "https://mail.com/" });
  const mail = S().windows[w].tabIds[0];
  const page = S().newTab(w, { url: "https://a.com/" });
  S().pinTabs([mail], true);
  setPage(mail, { kind: "asleep" });
  setPage(page, { kind: "loaded", nav: { url: "https://a.com/", seq: 1 } });
  S().activate(page);
  assert.equal(empty(w), false);
  S().closeTab(page);
  assert.ok(S().windows[w], "the window stays for its pinned tab");
  assert.equal(S().tabs[S().windows[w].activeTabIds[S().windows[w].profileId]].url, "", "it shows a New Tab");
  assert.equal(empty(w), true);
});

test("the slide-out is counted when the window being empty brought it out, not when a hover already had the sidebar out", async () => {
  client.setSharing(true, "onboarding");
  const before = await emptyWindowPeeks();
  const count = emptyWindowPeekCount();

  count.byHand();
  count.opened();
  count.ask(true);
  assert.equal(await emptyWindowPeeks(), before, "out from a hover, then the window emptied: no slide-out");

  count.byHand();
  count.opened();
  assert.equal(await emptyWindowPeeks(), before, "a hover clears the empty window's request");

  count.ask(true);
  count.opened();
  assert.equal(await emptyWindowPeeks(), before + 1);

  count.opened();
  assert.equal(await emptyWindowPeeks(), before + 1, "counted once per slide-out");

  count.ask(false);
  count.opened();
  assert.equal(await emptyWindowPeeks(), before + 1);
});
