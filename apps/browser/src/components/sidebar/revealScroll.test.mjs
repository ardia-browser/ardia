import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../state/browser/store.ts");
const { revealTab } = await import("../../state/sidebar/reveal.ts");
const { registerRow } = await import("../../state/sidebar/sidebarUi.ts");
const { revealTargets } = await import("../../state/sidebar/revealTargets.ts");
const { revealScrollFor, startRevealTabs } = await import("./useRevealTabs.ts");

const S = () => useBrowser.getState();
const frames = [];
globalThis.requestAnimationFrame = (step) => frames.push(step);
globalThis.cancelAnimationFrame = () => {};
const runFrames = () => {
  while (frames.length) frames.shift()();
};

S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://0.example/" });
for (let i = 1; i < 60; i++) S().newTab(w, { url: `https://${i}.example/` });
S().activate(S().windows[w].tabIds[0]);

const scrolls = [];
const scroll = { current: { scrollTo: (move) => scrolls.push(move) } };
const scrollY = { current: 0 };
const geometry = { current: { viewport: 300, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false } };
const stop = startRevealTabs(w, scroll, scrollY, geometry);
runFrames();

test("opening a tab whose row is out of view scrolls the sidebar once, without animation", () => {
  scrollY.current = 0;
  scrolls.length = 0;
  S().newTab(w, { url: "https://new.example/" });
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, false);
  assert.equal(frames.length, 0, "no per-frame glide follows");
});

test("switching to a tab whose row is out of view scrolls the sidebar once, without animation", () => {
  const ids = S().windows[w].tabIds;
  S().activate(ids[0]);
  runFrames();
  scrollY.current = 0;
  scrolls.length = 0;
  S().activate(ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, false);
  assert.equal(frames.length, 0);
});

const sliding = () => {
  const page = { shown: false };
  geometry.current.ownerShown = () => page.shown;
  return page;
};
const arrive = (page) => {
  page.shown = true;
  geometry.current.laidOut?.();
  runFrames();
};
const atTop = () => {
  delete geometry.current.ownerShown;
  S().activate(S().windows[w].tabIds[0]);
  runFrames();
  scrollY.current = 0;
  scrolls.length = 0;
};

test("while the page that owns the scroll is still sliding in, its reveal waits; once it is shown, its selected tab is revealed once and nothing stays pending", () => {
  atTop();
  const page = sliding();
  S().activate(S().windows[w].tabIds[45]);
  runFrames();
  geometry.current.laidOut?.();
  runFrames();
  assert.equal(scrolls.length, 0, "no scroll while the pages move");
  arrive(page);
  assert.equal(scrolls.length, 1, "revealed as the pages come to rest");
  scrollY.current = 120;
  geometry.current.laidOut?.();
  runFrames();
  assert.equal(scrolls.length, 1, "a later scroll by the user is never overridden: nothing was left pending");
  delete geometry.current.ownerShown;
});

test("the pill's own animated scroll can't cancel a reveal, because a reveal never waits on scrolls", () => {
  atTop();
  const ids = S().windows[w].tabIds;
  revealTab(w, ids[40]);
  runFrames();
  assert.equal(scrolls.length, 1);
  const page = sliding();
  S().activate(ids[55]);
  runFrames();
  arrive(page);
  assert.equal(scrolls.length, 2);
  delete geometry.current.ownerShown;
});

for (const beforeFrame of [true, false]) {
  test(`closing the selected tab while its page slides in reveals the tab that takes its place at rest (closed ${beforeFrame ? "before" : "after"} the first frame)`, async () => {
    atTop();
    const ids = S().windows[w].tabIds;
    S().activate(ids[44]);
    runFrames();
    await new Promise((resolve) => setTimeout(resolve, 5));
    scrollY.current = 0;
    scrolls.length = 0;
    const page = sliding();
    S().activate(ids[45]);
    if (!beforeFrame) runFrames();
    S().closeTab(ids[45]);
    runFrames();
    const replacement = S().windows[w].activeTabIds[S().windows[w].profileId];
    assert.ok(S().windows[w].tabIds.indexOf(replacement) >= 40, "the tab that takes its place is deep too");
    arrive(page);
    assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
    assert.ok(scrolls[0].y > 300);
    delete geometry.current.ownerShown;
  });
}

test("closing the selected tab with no reveal waiting keeps the usual behaviour: nothing scrolls", () => {
  atTop();
  S().closeTab(S().windows[w].tabIds[0]);
  runFrames();
  assert.equal(scrolls.length, 0);
});

test("a reveal waiting for its page is dropped when the window moves to another profile meanwhile", () => {
  atTop();
  const home = S().windows[w].profileId;
  const page = sliding();
  S().activate(S().windows[w].tabIds[45]);
  runFrames();
  const empty = S().createProfile({ name: "Empty" });
  S().switchProfile(w, empty);
  runFrames();
  arrive(page);
  assert.equal(scrolls.length, 0, "the other profile's page isn't scrolled for the first one's tab");
  S().switchProfile(w, home);
  delete geometry.current.ownerShown;
  runFrames();
});

test("a measured tile's reveal still in flight never scrolls the page that took over the scroll", async () => {
  atTop();
  const ids = S().windows[w].tabIds;
  const tile = ids[3];
  S().pinTabs([tile], true);
  let measured = null;
  registerRow(w, tile, { measureInWindow: (done) => void (measured = done) });
  const scrolledB = [];
  const scrolledC = [];
  const before = scroll.current;
  scroll.current = { scrollTo: (move) => scrolledB.push(move), measureInWindow: (done) => done(0, 0) };
  S().activate(tile);
  runFrames();
  assert.ok(measured, "the tile's measurement is in flight");
  scroll.current = { scrollTo: (move) => scrolledC.push(move), measureInWindow: (done) => done(0, 0) };
  sliding();
  S().activate(ids[45]);
  runFrames();
  measured(0, 2000, 160, 40);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scrolledC, [], "page C's scroll belongs to C's own reveal");
  scroll.current = before;
  registerRow(w, tile, null);
  delete geometry.current.ownerShown;
});

test("a background tab the outgoing profile opens during the slide never scrolls the arriving page; the arriving page's selected tab wins at rest", async () => {
  atTop();
  const home = S().windows[w].profileId;
  const opener = S().windows[w].tabIds[2];
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const workTabs = [];
  for (let i = 0; i < 40; i++) workTabs.push(S().newTab(w, { url: `https://work${i}.example/` }));
  S().activate(workTabs.at(-1));
  S().switchProfile(w, home);
  runFrames();
  const before = scroll.current;
  const scrolled = [];
  scroll.current = { scrollTo: (move) => scrolled.push(move), measureInWindow: (done) => done(0, 0) };
  const page = sliding();
  S().switchProfile(w, work);
  runFrames();
  const background = S().newTab(w, { url: "https://opened.example/", background: true, openerId: opener, profileId: home });
  registerRow(w, background, { measureInWindow: (done) => done(0, 5000, 160, 34) });
  runFrames();
  arrive(page);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scrolled.length, 1, JSON.stringify(scrolled));
  assert.ok(scrolled[0].y < 3000, "the arriving page shows its own selected tab, not the outgoing page's new row");
  registerRow(w, background, null);
  scroll.current = before;
  S().switchProfile(w, home);
  delete geometry.current.ownerShown;
  runFrames();
});

test("a tile reveal still measuring when the user scrolls the page never overrides that scroll", async () => {
  atTop();
  const ids = S().windows[w].tabIds;
  const tile = ids[4];
  S().pinTabs([tile], true);
  let measured = null;
  registerRow(w, tile, { measureInWindow: (done) => void (measured = done) });
  const before = scroll.current;
  const scrolled = [];
  scroll.current = { scrollTo: (move) => scrolled.push(move), measureInWindow: (done) => done(0, 0) };
  const page = sliding();
  S().activate(tile);
  runFrames();
  arrive(page);
  assert.ok(measured, "the tile's measurement is in flight at rest");
  scrollY.current = 120;
  measured(0, 2000, 160, 40);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scrolled, [], "the user's scroll stays");
  scroll.current = before;
  registerRow(w, tile, null);
  delete geometry.current.ownerShown;
});

test("a selected tab that closes during the slide, before any frame could look at it, is replaced by the tab that takes its place at rest", async () => {
  atTop();
  const ids = S().windows[w].tabIds;
  S().activate(ids[46]);
  runFrames();
  await new Promise((resolve) => setTimeout(resolve, 5));
  scrollY.current = 0;
  scrolls.length = 0;
  const page = sliding();
  const before = scroll.current;
  scroll.current = null;
  S().activate(ids[47]);
  runFrames();
  S().closeTab(ids[47]);
  runFrames();
  scroll.current = before;
  arrive(page);
  assert.equal(scrolls.length, 1, "the replacement is revealed");
  assert.ok(scrolls[0].y > 300);
  delete geometry.current.ownerShown;
});

test("the selected-row pill's click is one native animated scroll", () => {
  const ids = S().windows[w].tabIds;
  scrollY.current = 0;
  scrolls.length = 0;
  revealTab(w, ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, true);
  assert.equal(frames.length, 0);
  stop();
});

test("a row already in view needs no scroll", () => {
  assert.equal(revealScrollFor({ y: 120, height: 32 }, { top: 0, viewport: 300 }, false), null);
});

const browserState = (tabIds, active) => ({
  windows: { w: { profileId: "p", activeTabIds: { p: active }, tabIds } },
  tabs: Object.fromEntries(tabIds.map((id) => [id, { id, windowId: "w", page: { kind: "live" } }])),
});

test("a new selected tab and a switch to an existing tab both reveal the selected tab", () => {
  const before = browserState(["a", "b"], "a");
  assert.deepEqual(revealTargets(browserState(["a", "b", "c"], "c"), before, "w"), { switched: "c", opened: null });
  assert.deepEqual(revealTargets(browserState(["a", "b"], "b"), before, "w"), { switched: "b", opened: null });
});

test("with Reduce Motion on, the pill's click jumps to the row instead of scrolling smoothly", () => {
  const ids = S().windows[w].tabIds;
  const still = startRevealTabs(w, scroll, scrollY, geometry, () => true);
  scrollY.current = 0;
  scrolls.length = 0;
  revealTab(w, ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, false);
  still();
});

test("a reveal while the launch holds this window's rows lets them in before it scrolls there", async () => {
  const launch = await import("../../state/sidebar/launchRows.ts");
  delete geometry.current.ownerShown;
  const watching = startRevealTabs(w, scroll, scrollY, geometry);
  launch.resetLaunchRowsForTests();
  launch.startLaunchRows();
  assert.equal(launch.launchRowsHolding(w), true);
  const ids = S().windows[w].tabIds;
  scrollY.current = 0;
  scrolls.length = 0;
  S().activate(ids[50]);
  runFrames();
  assert.equal(launch.launchRowsHolding(w), false);
  assert.equal(launch.launchRowsReport().release, "reveal");
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  watching();
  launch.resetLaunchRowsForTests();
});

test("a tab reveal finishes the folds still filling in, so the row it scrolls to is mounted", async () => {
  const { fillingFold } = await import("./foldFlush.ts");
  const ids = S().windows[w].tabIds;
  const g = { current: { viewport: 300, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false } };
  const watching = startRevealTabs(w, { current: { scrollTo() {} } }, { current: 0 }, g);
  runFrames();
  S().activate(ids[0]);
  runFrames();
  let flushed = 0;
  const stop = fillingFold(w, () => {
    flushed++;
    stop();
  });
  S().activate(ids[45]);
  runFrames();
  stop();
  watching();
  assert.equal(flushed, 1);
});

test("a reveal that has to scroll waits for the window's folds to finish first, and one already in view doesn't touch them", async () => {
  const { fillingFold } = await import("./foldFlush.ts");
  const ids = S().windows[w].tabIds;
  const asked = [];
  const g = { current: { viewport: 300, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false } };
  const watching = startRevealTabs(w, { current: { scrollTo: (move) => asked.push(move) } }, { current: 0 }, g);
  runFrames();
  S().activate(ids[0]);
  runFrames();
  asked.length = 0;
  let flushed = 0;
  const other = fillingFold("another-window", () => flushed++);
  let stop = fillingFold(w, () => {
    flushed++;
    stop();
  });
  S().activate(ids[1]);
  runFrames();
  assert.equal(flushed, 0, "a row already in view needs no flush, here or in another window");
  S().activate(ids[45]);
  runFrames();
  assert.equal(flushed, 1);
  assert.equal(asked.length, 0, "the scroll waits for the fold to finish");
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    runFrames();
  }
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(asked.length, 1);
  other();
  watching();
});

test("R5-S2/S3: a reveal deferred behind a flush redoes its sums afterwards, and gives up after a newer pick, a scroll or a close", async () => {
  const { fillingFold } = await import("./foldFlush.ts");
  const ids = S().windows[w].tabIds;
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      runFrames();
    }
    await new Promise((done) => setTimeout(done, 0));
  };
  const run = async ({ moveList = 0, between = () => false } = {}) => {
    const asked = [];
    const at = { current: 0 };
    const g = { current: { viewport: 300, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false } };
    const watching = startRevealTabs(w, { current: { scrollTo: (move) => asked.push(move) } }, at, g);
    runFrames();
    S().activate(ids[0]);
    runFrames();
    asked.length = 0;
    const stop = fillingFold(w, () => {
      g.current.regions.list = moveList;
      stop();
    });
    S().activate(ids[45]);
    runFrames();
    const closed = between({ at, watching });
    await settle();
    if (!closed) watching();
    return asked;
  };
  const still = await run();
  assert.equal(still.length, 1);
  const moved = await run({ moveList: 500 });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].y, still[0].y + 500, "the scroll is worked out once the fold has settled");
  assert.equal((await run({ between: () => (S().activate(ids[2]), false) })).filter((m) => m.y === still[0].y).length, 0, "a newer pick wins");
  assert.equal((await run({ between: ({ at }) => ((at.current = 40), false) })).length, 0, "the user's scroll wins");
  assert.equal((await run({ between: ({ watching }) => (watching(), true) })).length, 0, "a closed window scrolls nothing");
  S().activate(ids[0]);
  runFrames();
});
