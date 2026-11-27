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
const { noteSidebarRowsLaidOut, useSidebarRowGeometry } = await import("../../state/sidebar/rowGeometry.ts");
const { ICON_STRIP, stripLayout } = await import("./iconStripGeometry.ts");
const { registerSidebarDrag } = await import("./stripDrag.ts");
const { useRowCenters } = await import("./useRowCenters.ts");

const scene = { keys: Array.from({ length: 8 }, (_, i) => `t:${i}`), above: 0, scale: 1 };
const pitch = () => layout.rowHeight + layout.rowGap;
const center = (i) => (120 + scene.above + i * pitch() + layout.rowHeight / 2) * scene.scale;
const contentOf = () => ({ width: 176, height: Math.round(scene.above + scene.keys.length * pitch()) });
registerSidebarDrag("w", () => ({
  items: new Map(scene.keys.map((key, i) => [key, { view: { measureInWindow: (cb) => cb(9, center(i) - (layout.rowHeight * scene.scale) / 2, 172, layout.rowHeight * scene.scale) } }])),
}));

const laidOut = () => noteSidebarRowsLaidOut("w", contentOf());
const collect = () => useRowCenters("w", scene.keys, 0, false, `1200x800:9:${useSidebarRowGeometry.getState().w?.version ?? 0}`);
async function settled() {
  for (let frame = 0; frame < 4; frame++) await new Promise((r) => setTimeout(r, 0));
}

async function worstOffset() {
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

test("the sidebar laying out at the same size again leaves the strip's measurements alone", () => {
  laidOut();
  const version = useSidebarRowGeometry.getState().w.version;
  laidOut();
  assert.equal(useSidebarRowGeometry.getState().w.version, version);
});

test("an aligned row the sidebar hasn't measured yet reserves the square it is drawn at, not the full square", () => {
  const items = ["a", "b", "c", "d"].map((key) => ({ key, divider: false, aligned: true }));
  const { slots, square } = stripLayout(items, { a: 100, b: 126 }, 9);
  assert.equal(square, 24, "the measured rows are packed tight");
  assert.equal(slots[3].top - slots[2].top, square + ICON_STRIP.gap, "the unmeasured row takes the drawn square plus the gap");
});
