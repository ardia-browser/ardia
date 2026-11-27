import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
await import("../../test-native/index.ts");
const remembered = "file:///virtual/rememberedHooks.mjs";
registerHooks({
  resolve: (specifier, context, next) => (specifier === "react" && context.parentURL?.endsWith("useRowCenters.ts") ? { url: remembered, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) =>
    url === remembered
      ? {
          format: "module",
          source: "let state, last, cleanup; export function useState(initial) { state ??= initial; return [state, (update) => { state = update(state); }]; } export function useEffect(effect, deps) { if (last?.every((v, i) => Object.is(v, deps[i]))) return; cleanup?.(); last = deps; cleanup = effect(); }",
          shortCircuit: true,
        }
      : next(url, context),
});
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { DEFAULT_LOOK, withSidebarText } = await import("../../lib/themeLook.ts");
const { setActiveLook } = await import("../../lib/activeLook.ts");
const { layout } = await import("../ui/theme.ts");
const { useInterfaceScale } = await import("../../state/settings/interfaceScale.ts");
const { noteSidebarRowMoved, useSidebarRowGeometry } = await import("../../state/sidebar/rowGeometry.ts");
const { ICON_STRIP, STRIP_DIVIDER_HEIGHT, stripLayout, stripMeasureKey } = await import("./iconStripGeometry.ts");
const { registerSidebarDivider, registerSidebarDrag } = await import("./stripDrag.ts");
const { useRowCenters } = await import("./useRowCenters.ts");

const scene = { keys: Array.from({ length: 8 }, (_, i) => `t:${i}`), above: 0, scale: 1 };
const pitch = () => layout.rowHeight + layout.rowGap;
const center = (i) => (120 + scene.above + i * pitch() + layout.rowHeight / 2) * scene.scale;
registerSidebarDrag("w", () => ({
  items: new Map(scene.keys.map((key, i) => [key, { view: { measureInWindow: (cb) => cb(9, center(i) - (layout.rowHeight * scene.scale) / 2, 172, layout.rowHeight * scene.scale) } }])),
}));

const laidOut = () => noteSidebarRowMoved("w");
const collect = () => useRowCenters("w", scene.keys, 0, false, `1200x800:9:${useSidebarRowGeometry.getState().w ?? 0}`);
async function settled() {
  for (let frame = 0; frame < 4; frame++) await new Promise((r) => setTimeout(r, 0));
}

async function worstOffset() {
  await settled();
  collect();
  await settled();
  const centers = collect();
  const { slots, square } = stripLayout(scene.keys.map((key) => ({ key, divider: false, aligned: true })), centers, 9);
  return Math.max(...slots.map(({ top }, i) => Math.abs(top + square / 2 - center(i))));
}

async function alignedAfter(change, undo) {
  assert.ok((await worstOffset()) <= 1, "aligned before");
  change();
  const after = await worstOffset();
  undo();
  await worstOffset();
  return after;
}

test("every icon follows its row after the Sidebar Text Size changes", async () => {
  assert.ok((await alignedAfter(() => setActiveLook(withSidebarText(DEFAULT_LOOK, "larger")), () => setActiveLook(DEFAULT_LOOK))) <= 1);
});

test("every icon follows its row after the interface scale changes", async () => {
  const change = () => ((scene.scale = 1.25), useInterfaceScale.setState({ scale: 1.25 }));
  const undo = () => ((scene.scale = 1), useInterfaceScale.setState({ scale: 1 }));
  assert.ok((await alignedAfter(change, undo)) <= 1);
});

test("every icon follows its row after a look with other row metrics, or Minimalism hiding what sits above the rows", async () => {
  const tight = { ...DEFAULT_LOOK, metrics: { rowHeight: 28, rowGap: 2, pinnedHeight: 34 } };
  assert.ok((await alignedAfter(() => setActiveLook(tight), () => setActiveLook(DEFAULT_LOOK))) <= 1);
  scene.above = 80;
  laidOut();
  const hide = () => ((scene.above = 0), laidOut());
  const show = () => ((scene.above = 80), laidOut());
  assert.ok((await alignedAfter(hide, show)) <= 1);
  scene.above = 0;
  laidOut();
});

test("every icon follows its row after a folder above them opens or closes", async () => {
  const open = () => ((scene.above = 3 * pitch()), laidOut());
  const close = () => ((scene.above = 0), laidOut());
  assert.ok((await alignedAfter(open, close)) <= 1);
  open();
  assert.ok((await alignedAfter(close, open)) <= 1);
  close();
});

test("every icon follows its row after a group above them collapses or expands", async () => {
  const all = scene.keys;
  const collapse = () => ((scene.keys = [all[0], ...all.slice(4)]), laidOut());
  const expand = () => ((scene.keys = all), laidOut());
  assert.ok((await alignedAfter(collapse, expand)) <= 1);
});

test("every icon follows its row after tabs are added or removed", async () => {
  const all = scene.keys;
  const add = () => ((scene.keys = ["t:new", ...all]), laidOut());
  const remove = () => ((scene.keys = all.filter((key) => key !== "t:2")), laidOut());
  const back = () => ((scene.keys = all), laidOut());
  assert.ok((await alignedAfter(add, back)) <= 1);
  assert.ok((await alignedAfter(remove, back)) <= 1);
});

test("rows trading places without the list changing size (an equal folder opening as another closes) still move every icon", async () => {
  const open = () => ((scene.above = 3 * pitch()), laidOut());
  const swap = () => ((scene.above = 0), laidOut());
  open();
  assert.ok((await alignedAfter(swap, open)) <= 1);
  swap();
});

test("many rows laying out in one frame bump the strip's measurements once", async () => {
  await settled();
  const before = useSidebarRowGeometry.getState().w ?? 0;
  for (let i = 0; i < 20; i++) laidOut();
  await settled();
  assert.equal(useSidebarRowGeometry.getState().w, before + 1);
});

test("an aligned row the sidebar hasn't measured yet reserves the square it is drawn at, not the full square", () => {
  const items = ["a", "b", "c", "d"].map((key) => ({ key, divider: false, aligned: true }));
  const { slots, square } = stripLayout(items, { a: 100, b: 126 }, 9);
  assert.equal(square, 24, "the measured rows are packed tight");
  assert.equal(slots[3].top - slots[2].top, square + ICON_STRIP.gap, "the unmeasured row takes the drawn square plus the gap");
});

test("moving the inline New Tab row from the bottom to the top re-measures, though no row or scroll content lays out anew", async () => {
  const key = (top) => stripMeasureKey("1200x800:9", useSidebarRowGeometry.getState().w ?? 0, top, scene.keys.map((k) => `tab\u0001${k}`));
  const measure = async (top) => {
    await settled();
    useRowCenters("w", scene.keys, 0, false, key(top));
    await settled();
    const centers = useRowCenters("w", scene.keys, 0, false, key(top));
    const { slots, square } = stripLayout(scene.keys.map((k) => ({ key: k, divider: false, aligned: true })), centers, 9);
    return Math.max(...slots.map(({ top: y }, i) => Math.abs(y + square / 2 - center(i))));
  };
  assert.ok((await measure(false)) <= 1);
  scene.above = pitch();
  assert.ok((await measure(false)) >= pitch() - 1, "a key without the New Tab position leaves the icons a row off");
  const moved = await measure(true);
  scene.above = 0;
  assert.ok((await measure(false)) <= 1);
  assert.ok(moved <= 1, `the first row moved ${pitch()} pt with the New Tab row and its icon followed (off by ${moved})`);
});

const withTiles = (n) => [...Array.from({ length: n }, (_, i) => ({ key: `tile:t:${i}`, divider: false })), { key: "divider:list", divider: true }, { key: "a", divider: false, aligned: true }, { key: "b", divider: false, aligned: true }];
const lineOf = (layout) => layout.slots[4].top + STRIP_DIVIDER_HEIGHT / 2;

test("the divider under Top Apps sits at the sidebar divider's measured height, so it stays put when the sidebar floats out", () => {
  const packed = stripLayout(withTiles(4), { a: 300, b: 337 }, 9);
  assert.equal(packed.slots[4].top, 9 + 4 * (ICON_STRIP.square + ICON_STRIP.gap), "unmeasured, it packs under the tiles as before");
  const measured = stripLayout(withTiles(4), { a: 300, b: 337, "divider:list": 220 }, 9);
  assert.ok(Math.abs(lineOf(measured) - 220) <= 0.5, `the line is at ${lineOf(measured)}`);
  assert.equal(measured.slots[5].top, packed.slots[5].top, "the rows keep their places");
  assert.equal(lineOf(stripLayout(withTiles(4), { a: 300, b: 337, "divider:list": 100 }, 9)), lineOf(packed), "never above the last tile");
  const low = stripLayout(withTiles(4), { a: 300, b: 337, "divider:list": 299 }, 9);
  assert.ok(low.slots[4].top + STRIP_DIVIDER_HEIGHT <= low.slots[5].top, "never into the first row");
});

test("the strip measures the sidebar's divider band with its rows", async () => {
  const band = { measureInWindow: (cb) => cb(9, 200, 172, 20) };
  const register = registerSidebarDivider("w");
  register(band);
  try {
    await settled();
    useRowCenters("w", scene.keys, 0, false, "divider-test", "divider:list");
    await settled();
    const centers = useRowCenters("w", scene.keys, 0, false, "divider-test", "divider:list");
    assert.equal(centers["divider:list"], 210);
  } finally {
    register(null);
  }
});
