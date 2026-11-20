import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { rowAway, visibleSpan } = await import("./selectedRow.ts");
const { GLOW_ROOM } = await import("./pageLayout.ts");
import { mount } from "../../test-hooks.mjs";
globalThis.require ??= (id) => ({ asset: id });
globalThis.requestAnimationFrame ??= (run) => setTimeout(run, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
const { useSelectedRowAway } = await import("./SelectedRowPill.tsx");

const row = (y, height = 34) => ({ y, height });

test("the pill points down only once the selected row is wholly below the list, as in Dia", () => {
  assert.equal(rowAway(row(600), 0, 500), "below");
  assert.equal(rowAway(row(500), 0, 500), "below");
  assert.equal(rowAway(row(480), 0, 500), null);
  assert.equal(rowAway(row(200), 0, 500), null);
});

test("the pill points up once the selected row is wholly above the list's visible top", () => {
  const scrolled = 400;
  const top = visibleSpan(scrolled, 500).top;
  assert.equal(top, scrolled + GLOW_ROOM);
  assert.equal(rowAway(row(top - 34), scrolled, 500), "above");
  assert.equal(rowAway(row(top - 20), scrolled, 500), null);
  assert.equal(rowAway(row(0), 0, 500), null);
  const lifted = visibleSpan(scrolled, 500, 3).top;
  assert.equal(lifted, scrolled + GLOW_ROOM - 3);
  assert.equal(rowAway(row(lifted - 32), scrolled, 500, 3), null, "a row still peeking under the lifted line shows no pill");
  assert.equal(rowAway(row(lifted - 34), scrolled, 500, 3), "above");
});

test("no pill without a selected row in the list, or before the list is laid out", () => {
  assert.equal(rowAway(null, 0, 500), null);
  assert.equal(rowAway(row(900), 0, 0), null);
});

test("the sidebar page measures no frame for the pill and never re-renders to show it", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /\{geometry \? <SelectedRowPill windowId=\{windowId\} tracker=\{selectedRow\}/);
  assert.match(page, /useSelectedRowAway\(windowId, geometry, scrollView, \(\) => page\.scrollY\)/);
  assert.doesNotMatch(page, /listFrame|useListFrame|pillNeeded/);
});

test("the pill reads no store while it shows: no external-store hook, no tab hooks, no store listener", () => {
  const pill = readFileSync(new URL("./SelectedRowPill.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(pill, /useSyncExternalStore|useActiveTabId|useTab\(|useBrowser|watchRowsMoved/);
  assert.match(pill, /watchWindowRecord\(windowId, tracker\.selectionMoved\)/);
  assert.match(pill, /if \(!away \|\| frame\) return;/, "a window change waits a frame only while the pill shows");
});

test("the pill's icon keeps what the row's icon shows: the engine badge, the faded look, a tint only through tintedImage", () => {
  const pill = readFileSync(new URL("./SelectedRowPill.tsx", import.meta.url), "utf8");
  assert.match(pill, /const engine = markedEngine\(tab\.marks\);/);
  assert.match(pill, /\{engine \? <EngineMark mark=\{engine\} size=\{size\} \/> : null\}/);
  assert.match(pill, /tab\.marks & FADED \? SLEEPING_OPACITY : 1/);
  assert.match(pill, /return tintedImage\(\{/);
});

test("the tracker hands the pill the selected tab only while its row is out of view, and keeps quiet otherwise", async (t) => {
  await import("../../test-native/index.ts");
  const { useBrowser } = await import("../../state/browser/store.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const ids = [S().windows[w].tabIds[0]];
  for (let i = 0; i < 30; i++) ids.push(S().newTab(w, { url: `https://t${i}.com/` }));
  S().activate(ids[0]);
  const geometry = { current: { viewport: 200, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  let scrollY = 0;
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: null }, () => scrollY));
  t.after(() => hook.unmount());
  const tracker = hook.value;
  const seen = [];
  const detach = tracker.attach((away) => seen.push(away));
  tracker.judge();
  assert.deepEqual(seen, [null], "in view at the top: the pill hears nothing new");
  scrollY = 900;
  tracker.judge();
  tracker.judge();
  assert.equal(seen.length, 2, "one change, however many scroll events");
  assert.equal(seen.at(-1)?.side, "above");
  assert.equal(seen.at(-1)?.tab.id, ids[0]);
  scrollY = 0;
  tracker.judge();
  assert.equal(seen.at(-1), null);
  detach();
});

test("the pill animates its value only while it is on screen, and builds its motion once per phase, so no native value is left with no view to hold it", async (t) => {
  const { Animated } = await import("react-native");
  const { SelectedRowPill } = await import("./SelectedRowPill.tsx");
  const timing = Animated.timing;
  const proto = Object.getPrototypeOf(new Animated.Value(0));
  const interpolate = proto.interpolate;
  let animations = 0;
  let interpolations = 0;
  Animated.timing = (value, config) => (animations++, timing(value, config));
  proto.interpolate = function (config) {
    interpolations++;
    return interpolate.call(this, config);
  };
  t.after(() => {
    Animated.timing = timing;
    proto.interpolate = interpolate;
  });
  let sink = () => {};
  const tracker = { attach: (next) => ((sink = next), next(null), () => {}), judge() {}, relocate() {} };
  const pill = mount(() => SelectedRowPill({ windowId: "w", tracker, lift: 0 }));
  t.after(() => pill.unmount());
  assert.equal(pill.value, null);
  assert.equal(animations, 0, "a hidden pill starts no animation, so its value never becomes native without a view");
  const tab = { id: "t", url: "https://a.com/", favicon: null, icon: null, profileId: "default", faviconUri: null, template: false, marks: 0 };
  for (let i = 0; i < 20; i++) {
    sink({ side: "above", tab });
    pill.value;
    pill.rerender();
    sink(null);
    pill.value;
    pill.rerender();
  }
  assert.equal(animations, 40, "one enter and one exit per show, none while hidden");
  assert.ok(interpolations <= 20 * 2 * 3, "the motion's interpolations are built once per phase, not on every render");
  const settled = animations;
  sink(null);
  pill.value;
  assert.equal(animations, settled, "hiding an already hidden pill animates nothing");
});
