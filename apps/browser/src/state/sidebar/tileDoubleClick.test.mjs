import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { webviews, webviewRef } = await import("../../platform/webviews.ts");
const { refreshShownTile } = await import("./actions.ts");
const held = await import("./heldTabPress.ts");
const { returnLiveTab } = await import("../live/engine.ts");
const { devTabPresses } = await import("../telemetry/tabPresses.ts");
const client = await import("../telemetry/client.ts");
const { shownLiveOf } = await import("../tabs/tabLive.ts");

const S = () => useBrowser.getState();
const go = (id, url, isLoading = false) => S().updateTab(id, { url, title: "" }, { isLoading, canGoBack: true, canGoForward: false });
const settle = () => new Promise((done) => setTimeout(done, 0));
const counts = () => {
  const t = devTabPresses();
  return { returns: t.tile_double_returns, reloads: t.tile_double_reloads, fresh: t.tile_double_fresh, missed: t.tile_double_missed };
};
const delta = (from) => Object.fromEntries(Object.entries(counts()).map(([k, v]) => [k, v - from[k]]));

const realNow = performance.now.bind(performance);
let clock = 1_000_000;
const navigations = [];
let realNavigate;
before(() => {
  realNavigate = S().navigate;
  useBrowser.setState({ navigate: (id, url, options) => (navigations.push([id, url]), realNavigate(id, url, options)) });
  performance.now = () => clock;
  client.setSharing(true, "settings");
});
after(() => {
  useBrowser.setState({ navigate: realNavigate });
  performance.now = realNow;
  client.setSharing(false, "settings");
});

let start = 50_000;
const event = (mods = {}, point = { x: 20, y: 20 }) => ({ nativeEvent: { identifier: "0", pageX: point.x, pageY: point.y, ...mods }, touchHistory: { touchBank: [{ startTimeStamp: ++start }] } });

function click(w, tabId, { mods = {}, point, gapMs = 120 } = {}) {
  clock += gapMs;
  const e = event(mods, point);
  const press = held.holdTabPress(w, tabId, e);
  clock += 60;
  held.clickHeldTabPress(w, tabId, e, press, (wasShown) => refreshShownTile(w, tabId, wasShown));
}

function doubleClick(w, tabId, first = {}, second = {}) {
  click(w, tabId, { gapMs: 2000, ...first });
  click(w, tabId, second);
}

function pinnedTile(url = "https://x.com/home") {
  S().hydrate({});
  navigations.length = 0;
  const w = S().createWindow({ url });
  const [tile] = S().windows[w].tabIds;
  const other = S().newTab(w, { url: "https://b.com/", background: true });
  S().pinTabs([tile], true);
  S().activate(tile);
  go(tile, url);
  const reloads = [];
  webviews.set(tile, { reload: () => (reloads.push(tile), Promise.resolve()) });
  webviews.set(other, { reload: () => (reloads.push(other), Promise.resolve()) });
  return { w, tile, other, reloads, done: () => (webviews.delete(tile), webviews.delete(other)) };
}

async function scenario(body, url) {
  const t = pinnedTile(url);
  try {
    await body(t);
  } finally {
    t.done();
  }
}

const navigatedTo = (id) => navigations.findLast(([tabId]) => tabId === id)?.[1];

test("double-clicking the shown tile away from its pinned URL goes back there and doesn't reload", () =>
  scenario(async ({ w, tile, reloads }) => {
    go(tile, "https://x.com/someone/status/1");
    const from = counts();
    doubleClick(w, tile);
    await settle();
    assert.equal(navigatedTo(tile), "https://x.com/home");
    assert.deepEqual(reloads, []);
    assert.deepEqual(delta(from), { returns: 1, reloads: 0, fresh: 0, missed: 0 });
  }));

test("double-clicking the shown tile already at its pinned URL reloads it once and counts one reload, the issue #3965 report", () =>
  scenario(async ({ w, tile, reloads }) => {
    const from = counts();
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
    assert.equal(S().tabs[tile].url, "https://x.com/home", "no navigation");
    assert.deepEqual(delta(from), { returns: 0, reloads: 1, fresh: 0, missed: 0 });
  }));

test("a fragment or trailing slash still counts as the pinned page, so it reloads", () =>
  scenario(async ({ w, tile, reloads }) => {
    go(tile, "https://docs.com/guide/#install");
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
    assert.equal(S().tabs[tile].url, "https://docs.com/guide/#install");
  }, "https://docs.com/guide"));

test("a pinned tile with no pinned URL reloads its current page", () =>
  scenario(async ({ w, tile, reloads }) => {
    S().updateTab(tile, { pinnedUrl: null });
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
  }));

test("a shown tile still loading is left to finish", () =>
  scenario(async ({ w, tile, reloads }) => {
    go(tile, "https://x.com/home", true);
    const from = counts();
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 1, missed: 0 });
  }));

test("a pair whose first click switched to the tile doesn't reload it, even before it reports loading", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    S().activate(other);
    const from = counts();
    doubleClick(w, tile);
    await settle();
    assert.equal(model.activeTabId(S(), w), tile, "the first click switched");
    assert.deepEqual(reloads, []);
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 1, missed: 0 });
  }));

test("a sleeping tile woken by the first click, its page mounted before any navigation event, isn't loaded twice", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    S().activate(other);
    S().closeTab(tile);
    assert.equal(S().tabs[tile].page.kind, "asleep");
    assert.equal(S().tabs[tile].url, "https://x.com/home");
    clock += 2000;
    const e = event();
    const press = held.holdTabPress(w, tile, e);
    assert.equal(model.activeTabId(S(), w), tile, "the press woke and showed it");
    held.clickHeldTabPress(w, tile, e, press, (wasShown) => refreshShownTile(w, tile, wasShown));
    assert.equal(shownLiveOf(S(), tile).isLoading, false, "no navigation event has said it is loading yet");
    assert.ok(webviews.get(tile), "and its page is already mounted");
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
  }));

test("a pair whose first click went back to the pinned URL from another tab still goes back", () =>
  scenario(async ({ w, tile, other }) => {
    go(tile, "https://x.com/elsewhere");
    S().activate(other);
    doubleClick(w, tile);
    assert.equal(navigatedTo(tile), "https://x.com/home");
  }));

test("a modified click in the pair never reloads or resets the shown tile", () =>
  scenario(async ({ w, tile, reloads }) => {
    const from = counts();
    doubleClick(w, tile, { mods: { metaKey: true } }, { mods: { metaKey: true } });
    doubleClick(w, tile, { mods: { shiftKey: true } }, {});
    doubleClick(w, tile, {}, { mods: { altKey: true } });
    doubleClick(w, tile, {}, { mods: { ctrlKey: true } });
    go(tile, "https://x.com/elsewhere");
    doubleClick(w, tile, { mods: { metaKey: true } }, {});
    await settle();
    assert.deepEqual(reloads, []);
    assert.equal(S().tabs[tile].url, "https://x.com/elsewhere");
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 0, missed: 0 });
  }));

test("clicks too slow, too far apart, on different tiles or split by a drag aren't a pair, and a third click doesn't pair again", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    click(w, tile, { gapMs: 2000 });
    click(w, tile, { gapMs: held.DOUBLE_CLICK_MS + 1 });
    click(w, tile, { gapMs: 2000 });
    click(w, tile, { point: { x: 20 + held.TAB_CLICK_SLOP, y: 20 } });
    click(w, tile, { gapMs: 2000 });
    held.endHeldTabPress([], null);
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
    doubleClick(w, tile);
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile], "the pair reloads once and the third click starts over");
    S().activate(other);
    click(w, tile, { gapMs: 2000 });
    click(w, other);
    await settle();
    assert.deepEqual(reloads, [tile]);
  }));

test("a reload that finds no page counts one miss and no reload", () =>
  scenario(async ({ w, tile }) => {
    webviews.delete(tile);
    const from = counts();
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 0, missed: 1 });
  }));

test("an outcome that lands after sharing went off isn't counted", () =>
  scenario(async ({ w, tile }) => {
    doubleClick(w, tile);
    client.setSharing(false, "settings");
    const from = counts();
    await settle();
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 0, missed: 0 });
    client.setSharing(true, "settings");
  }));

test("a late press after a drag never counts as the first click of a pair", () =>
  scenario(async ({ w, tile, reloads }) => {
    clock += 2000;
    const e = event();
    const press = held.holdTabPress(w, tile, e);
    held.endHeldTabPress([tile], null);
    clock += 60;
    held.clickHeldTabPress(w, tile, e, press, (wasShown) => refreshShownTile(w, tile, wasShown));
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
  }));

test("closing the tile's page between the clicks ends the pair: the click that wakes it doesn't reload it", () =>
  scenario(async ({ w, tile, reloads }) => {
    click(w, tile, { gapMs: 2000 });
    S().closeTab(tile);
    assert.equal(S().tabs[tile].page.kind, "asleep");
    const from = counts();
    click(w, tile);
    await settle();
    assert.equal(model.activeTabId(S(), w), tile, "the click woke and showed it");
    assert.equal(shownLiveOf(S(), tile).isLoading, false);
    assert.deepEqual(reloads, []);
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 1, missed: 0 });
  }));

test("closing the tile's page between the second press and its release never reloads the page it wakes", () =>
  scenario(async ({ w, tile, reloads }) => {
    click(w, tile, { gapMs: 2000 });
    clock += 120;
    const e = event();
    const press = held.holdTabPress(w, tile, e);
    S().closeTab(tile);
    clock += 60;
    held.clickHeldTabPress(w, tile, e, press, (wasShown) => refreshShownTile(w, tile, wasShown));
    await settle();
    assert.equal(model.activeTabId(S(), w), tile, "the release still shows it");
    assert.deepEqual(reloads, []);
  }));

test("closing and reopening the tile's page between the clicks ends the pair", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    click(w, tile, { gapMs: 2000 });
    S().closeTab(tile);
    S().activate(other);
    S().activate(tile);
    assert.notEqual(S().tabs[tile].page.kind, "asleep", "reopened");
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
  }));

test("a page mounted again between the clicks ends the pair", () =>
  scenario(async ({ w, tile, reloads }) => {
    const handle = { reload: () => (reloads.push(tile), Promise.resolve()) };
    webviewRef(tile)(handle);
    click(w, tile, { gapMs: 2000 });
    webviewRef(tile)(handle);
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile], "the same mount pairs as usual");
  }));

test("a pair across a shared pin's page swap still takes the tile back to its pinned URL, and never reloads", async () => {
  S().hydrate({});
  navigations.length = 0;
  const a = S().createWindow({ url: "https://mail.com/" });
  const [mail] = S().windows[a].tabIds;
  S().newTab(a, { url: "https://a.com/" });
  S().pinTabs([mail], true);
  S().activate(mail);
  const b = S().createWindow({ url: "https://b.com/" });
  const copy = model.viewTabIds(S(), b).find((id) => S().tabs[id].pinnedUrl === "https://mail.com/");
  S().activate(copy);
  assert.equal(S().tabs[mail].windowId, b, "B holds the page");
  go(mail, "https://mail.com/inbox/1");
  const frozen = model.activeTabId(S(), a);
  assert.equal(S().tabs[frozen].page.holderId, mail);
  const reloads = [];
  webviews.set(mail, { reload: () => (reloads.push(mail), Promise.resolve()) });
  try {
    click(a, frozen, { gapMs: 2000 });
    assert.equal(model.activeTabId(S(), a), mail, "the first click pulled the page into A, so the tile is now the page's own tab");
    assert.equal(S().tabs[mail].url, "https://mail.com/inbox/1");
    click(a, mail);
    await settle();
    assert.equal(navigatedTo(mail), "https://mail.com/", "the pair still went back to the pinned URL");
    assert.deepEqual(reloads, []);
    go(mail, "https://mail.com/");
    S().activate(model.viewTabIds(S(), a).find((id) => !S().tabs[id].pin));
    S().activate(model.viewTabIds(S(), b).find((id) => S().tabs[id].pinnedUrl === "https://mail.com/"));
    const shownInA = model.activeTabId(S(), a);
    click(a, shownInA, { gapMs: 2000 });
    click(a, model.activeTabId(S(), a));
    await settle();
    assert.deepEqual(reloads, [], "a pair at the pinned URL across the swap never reloads: the page changed under it");
  } finally {
    webviews.delete(mail);
  }
});

test("another tab shown while the first click is held makes that click ineligible, though its release shows the tile again", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    clock += 2000;
    const e = event();
    const press = held.holdTabPress(w, tile, e);
    S().activate(other);
    clock += 60;
    held.clickHeldTabPress(w, tile, e, press, (wasShown) => refreshShownTile(w, tile, wasShown));
    assert.equal(model.activeTabId(S(), w), tile, "the release showed the tile again");
    click(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
  }));

test("keyboard activations, which carry no pointer, still switch tabs but never make a pair", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    const key = () => ({ nativeEvent: { identifier: "0" }, touchHistory: { touchBank: [{ startTimeStamp: ++start }] } });
    const press = (tabId) => {
      clock += 100;
      const e = key();
      const p = held.holdTabPress(w, tabId, e);
      held.clickHeldTabPress(w, tabId, e, p, (wasShown) => refreshShownTile(w, tabId, wasShown));
    };
    press(other);
    assert.equal(model.activeTabId(S(), w), other, "a keyboard press still switches");
    press(tile);
    assert.equal(model.activeTabId(S(), w), tile);
    press(tile);
    press(tile);
    clock += 2000;
    const e = event();
    const p = held.holdTabPress(w, tile, e);
    held.clickHeldTabPress(w, tile, e, p, (wasShown) => refreshShownTile(w, tile, wasShown));
    press(tile);
    await settle();
    assert.deepEqual(reloads, []);
  }));

test("a reload the engine rejects counts one miss, no reload and no unhandled rejection", () =>
  scenario(async ({ w, tile }) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      webviews.set(tile, { reload: () => Promise.reject(new Error("no tab")) });
      const from = counts();
      doubleClick(w, tile);
      await settle();
      await settle();
      assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 0, missed: 1 });
      webviews.set(tile, {
        reload: () => {
          throw new Error("gone");
        },
      });
      doubleClick(w, tile);
      await settle();
      await settle();
      assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 0, missed: 2 });
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }));

test("a reload counts only once the engine accepts it", () =>
  scenario(async ({ w, tile }) => {
    let accept;
    webviews.set(tile, { reload: () => new Promise((done) => (accept = done)) });
    const from = counts();
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(delta(from), { returns: 0, reloads: 0, fresh: 0, missed: 0 });
    accept();
    await settle();
    assert.deepEqual(delta(from), { returns: 0, reloads: 1, fresh: 0, missed: 0 });
  }));

test("a tile that isn't shown when the action runs does nothing", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    S().activate(other);
    refreshShownTile(w, tile, true);
    await settle();
    assert.deepEqual(reloads, []);
  }));

test("in a split, only the shown pane's tile reloads", () =>
  scenario(async ({ w, tile, other, reloads }) => {
    S().createSplit([tile, other]);
    S().activate(tile);
    doubleClick(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
    S().activate(other);
    refreshShownTile(w, tile, true);
    await settle();
    assert.deepEqual(reloads, [tile]);
  }));

test("Back to Pinned URL from ⌘↩, menus, the socket and live folders still never reloads", () =>
  scenario(async ({ tile, reloads }) => {
    S().returnToPinnedUrl(tile);
    returnLiveTab(tile);
    await settle();
    assert.deepEqual(reloads, []);
    go(tile, "https://x.com/elsewhere");
    S().returnToPinnedUrl(tile);
    assert.equal(navigatedTo(tile), "https://x.com/home");
    assert.deepEqual(reloads, []);
  }));

test("Top Apps and the top strip's pinned dock pass their double-click through the tab press, never a view's onDoubleClick", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  for (const file of ["../../components/sidebar/PinnedGrid.tsx", "../../components/tabstrip/PinnedDock.tsx"]) {
    const src = read(file);
    assert.match(src, /<TabPressArea [^>]*onDoubleClick=\{\(wasShown\) => refreshShownTile\(windowId, tabId, wasShown\)\}/, file);
    assert.doesNotMatch(src, /^\s+onDoubleClick=/m, `${file} has no view-level double-click to swallow the release`);
  }
  assert.match(read("../../components/sidebar/TabPressArea.tsx"), /clickHeldTabPress\(windowId, tab\.id, e, press\.current, onDoubleClick\)/);
  assert.match(read("../../components/sidebar/TabRow.tsx"), /onDoubleClick=\{\(\) => void startRename\(/, "rows keep double-click to rename");
});
