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
  assert.match(pill, /watchSelectedPlace\(windowId, tracker\.selectionMoved\)/);
  assert.match(pill, /if \(frame \|\| \(!away && !movedInPlace\(was, selectedAt\)\)\) return;/, "a hidden pill rechecks only when the selected tab moved in the order");
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

const pillWindow = async () => {
  await import("../../test-native/index.ts");
  const { useBrowser } = await import("../../state/browser/store.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const ids = [S().windows[w].tabIds[0]];
  for (let i = 0; i < 30; i++) ids.push(S().newTab(w, { url: `https://t${i}.com/` }));
  return { S, w, ids };
};
const frame = () => new Promise((resolve) => setTimeout(resolve, 5));

test("moving the hidden pill's tab out of view shows the pill without waiting for a scroll", async (t) => {
  const { S, w, ids } = await pillWindow();
  S().activate(ids[0]);
  const geometry = { current: { viewport: 200, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: null }, () => 0));
  t.after(() => hook.unmount());
  const seen = [];
  const detach = hook.value.attach((away) => seen.push(away));
  t.after(detach);
  hook.value.judge();
  assert.equal(seen.at(-1), null);
  S().moveTab(ids[0], 30);
  await frame();
  assert.equal(seen.at(-1)?.side, "below", "the reorder alone brings the pill");
  const shownAt = seen.length;
  S().activate(ids[1]);
  S().activate(ids[0]);
  await frame();
  assert.ok(seen.length - shownAt <= 1);
});

test("a hidden pill hears nothing from a tab switch that leaves the order alone", async (t) => {
  const { S, w, ids } = await pillWindow();
  S().activate(ids[0]);
  const geometry = { current: { viewport: 2000, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: null }, () => 0));
  t.after(() => hook.unmount());
  hook.value.attach(() => {});
  const raf = globalThis.requestAnimationFrame;
  let frames = 0;
  globalThis.requestAnimationFrame = (run) => (frames++, raf(run));
  t.after(() => (globalThis.requestAnimationFrame = raf));
  S().activate(ids[3]);
  await frame();
  assert.equal(frames, 0, "a switch with the pill hidden schedules no recheck");
  const opened = S().newTab(w, { url: "https://new.com/" });
  await frame();
  S().closeTab(opened);
  await frame();
  S().activate(ids[5]);
  await frame();
  assert.equal(frames, 0, "opening, closing and switching again schedule no recheck either");
});

test("a shown pill takes the favicon once it resolves, and the template tint learnt after", async (t) => {
  const { S, w, ids } = await pillWindow();
  const { adoptFavicons } = await import("../../state/favicons/favicons.ts");
  S().activate(ids[0]);
  const geometry = { current: { viewport: 200, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: null }, () => 900));
  t.after(() => hook.unmount());
  const seen = [];
  t.after(hook.value.attach((away) => seen.push(away)));
  hook.value.judge();
  assert.equal(seen.at(-1)?.tab.faviconUri, null);
  adoptFavicons(S().tabs[ids[0]].profileId, [{ page: "https://a.com/", icon: "https://a.com/favicon.ico", png: "iVBOR" }]);
  assert.equal(seen.at(-1)?.tab.faviconUri, "data:image/png;base64,iVBOR", "the resolved icon reaches the pill with no scroll");
  const shown = seen.length;
  hook.value.judge();
  assert.equal(seen.length, shown, "a scroll after that changes nothing");
  const { useFavicons } = await import("../../state/favicons/favicons.ts");
  useFavicons.setState((f) => ({ themes: { ...f.themes, "data:image/png;base64,iVBOR": { kind: "template", stroke: "#000" } } }));
  assert.equal(seen.at(-1)?.tab.template, true, "a template icon learnt while the pill shows takes the tint");
});

test("a scroll after the favicon resolves gives the pill the resolved icon, not the fallback it showed", async (t) => {
  const { S, w, ids } = await pillWindow();
  const { useFavicons } = await import("../../state/favicons/favicons.ts");
  S().activate(ids[1]);
  const geometry = { current: { viewport: 50, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: null }, () => 0));
  t.after(() => hook.unmount());
  const seen = [];
  t.after(hook.value.attach((away) => seen.push(away)));
  hook.value.judge();
  assert.equal(seen.at(-1)?.tab.faviconUri, null);
  const key = Object.keys(useFavicons.getState().profiles)[0] ?? S().tabs[ids[1]].profileId;
  useFavicons.setState((f) => {
    const icons = f.profiles[key] ?? { pages: {}, srcs: {}, appearances: {} };
    return { profiles: { ...f.profiles, [key]: { ...icons, pages: { ...icons.pages, "https://t0.com/": "data:image/png;base64,T0" } } } };
  });
  hook.value.judge();
  assert.equal(seen.at(-1)?.tab.faviconUri, "data:image/png;base64,T0");
});

test("a resized sidebar page tells the pill its new height before the pill judges", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  const layout = page.slice(page.indexOf("onLayout={(e) => {"), page.indexOf("onContentSizeChange"));
  assert.ok(layout.indexOf("geometry.current.viewport = page.viewport") >= 0);
  assert.ok(layout.indexOf("geometry.current.viewport = page.viewport") < layout.indexOf("selectedRow.relocate()"), "the viewport is stored before relocate reads it");
});

test("moving the hidden pill's tab out of its group, at the same window index, still brings the pill", async (t) => {
  const { S, w, ids } = await pillWindow();
  const last = ids[18];
  S().createGroup(ids.slice(10, 19), { name: "G" });
  S().activate(last);
  const before = S().windows[w].tabIds.indexOf(last);
  const geometry = { current: { viewport: 200, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  let scrollY = 0;
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: null }, () => scrollY));
  t.after(() => hook.unmount());
  const seen = [];
  t.after(hook.value.attach((away) => seen.push(away)));
  const { rowSpan } = await import("../../state/sidebar/geometry.ts");
  const { locateTab } = await import("./selectedRow.ts");
  const top = rowSpan(S(), w, S().windows[w].profileId, last, false).top;
  scrollY = locateTab(w, last, geometry.current, null, () => 0).y + 2 - geometry.current.viewport;
  hook.value.relocate();
  assert.equal(seen.at(-1) ?? null, null, "the row peeks in at the bottom edge");
  S().moveTabBy(last, 1);
  assert.equal(S().windows[w].tabIds.indexOf(last), before, "the move keeps the window index");
  assert.notEqual(rowSpan(S(), w, S().windows[w].profileId, last, false).top, top, "but the row moved");
  await frame();
  assert.equal(seen.at(-1)?.side, "below");
});

test("coming back to a page whose pill still shows re-attaches the icon watch", async (t) => {
  const { S, w, ids } = await pillWindow();
  const { adoptFavicons } = await import("../../state/favicons/favicons.ts");
  S().activate(ids[2]);
  const geometry = { current: { viewport: 200, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  let shownGeometry = geometry;
  const hook = mount(() => useSelectedRowAway(w, shownGeometry, { current: null }, () => 900));
  t.after(() => hook.unmount());
  const seen = [];
  t.after(hook.value.attach((away) => seen.push(away)));
  hook.value.judge();
  assert.equal(seen.at(-1)?.side, "above");
  shownGeometry = undefined;
  hook.rerender();
  shownGeometry = geometry;
  hook.rerender();
  adoptFavicons(S().tabs[ids[2]].profileId, [{ page: "https://t1.com/", icon: "https://t1.com/favicon.ico", png: "BACK" }]);
  assert.equal(seen.at(-1)?.tab.faviconUri, "data:image/png;base64,BACK");
});

test("a row measurement that lands after the tracker stops installs no watch", async (t) => {
  const { S, w, ids } = await pillWindow();
  const { useLive } = await import("../../state/live/store.ts");
  const { registerRow } = await import("../../state/sidebar/sidebarUi.ts");
  const { watchTabState } = await import("../../state/tabs/tabStateWatch.ts");
  const profileId = S().windows[w].profileId;
  const live = useLive.getState();
  useLive.setState({ folderOrder: ["f"], folders: { ...live.folders, f: { ...(Object.values(live.folders)[0] ?? {}), id: "f", profileId } } });
  t.after(() => useLive.setState({ folderOrder: live.folderOrder, folders: live.folders }));
  S().pinTabs([ids[0]], true);
  S().activate(ids[0]);
  const pending = [];
  const view = { measureInWindow: (done) => pending.push(done) };
  registerRow(w, ids[0], view);
  t.after(() => registerRow(w, ids[0], null));
  const geometry = { current: { viewport: 200, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false, edgeLift: 0 } };
  const list = { measureInWindow: (done) => pending.push((x, y, width, height) => done(x, y + 2000, width, height)) };
  const hook = mount(() => useSelectedRowAway(w, geometry, { current: list }, () => 900));
  const seen = [];
  hook.value.attach((away) => seen.push(away));
  hook.value.relocate();
  assert.ok(pending.length > 0, "the row is measured natively");
  hook.unmount();
  let woken = 0;
  const off = watchTabState(ids[0], () => woken++);
  t.after(off);
  for (let i = 0; pending.length && i < 5; i++) {
    for (const done of pending.splice(0)) done(0, 0, 200, 34);
    await frame();
  }
  assert.equal(seen.length, 1, "the late measurement shows no pill for a stopped tracker");
  const count = seen.length;
  S().navigate(ids[0], "https://changed.com/");
  await frame();
  assert.equal(seen.length, count, "the stopped tracker hears nothing from that tab");
});
