import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../state/browser/store.ts");
const { revealTab } = await import("../../state/sidebar/reveal.ts");
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
