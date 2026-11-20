import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { rowAway, visibleSpan } = await import("./selectedRow.ts");
const { GLOW_ROOM } = await import("./pageLayout.ts");
import { mount } from "../../test-hooks.mjs";
globalThis.require ??= (id) => ({ asset: id });
const { useListFrame } = await import("./SelectedRowPill.tsx");

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

test("the pill's shown state lives in the pill, so its showing never re-renders the sidebar page", () => {
  const pill = readFileSync(new URL("./SelectedRowPill.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  const tracker = pill.slice(pill.indexOf("export function useSelectedRowAway"), pill.indexOf("export function SelectedRowPill"));
  assert.doesNotMatch(tracker, /useState<RowAway>/);
  assert.match(pill, /const away = useSyncExternalStore\(source\.subscribe, source\.read, source\.read\);/);
  assert.match(page, /<SelectedRowPillFrame frame=\{listFrame\} lift=\{edgeLift\} windowId=\{windowId\} away=\{selectedRow\.away\}/);
});

test("the list's frame for the pill lives outside the page's state, so a list layout at launch never re-renders the sidebar page", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /const listFrame = useListFrame\(\);/);
  assert.match(page, /onLayout=\{listFrame\.onLayout\}/);
  assert.doesNotMatch(page, /setListFrame/);
});

test("the list frame notifies the pill only when the list's top or height changes", (t) => {
  const frame = mount(() => useListFrame());
  t.after(() => frame.unmount());
  const source = frame.value;
  let notified = 0;
  source.subscribe(() => notified++);
  const layout = (y, height) => source.onLayout({ nativeEvent: { layout: { x: 0, y, width: 200, height } } });
  layout(40, 600);
  layout(40, 600);
  assert.equal(notified, 1);
  assert.deepEqual(source.read(), { top: 40, height: 600 });
  layout(40, 520);
  assert.equal(notified, 2);
  assert.deepEqual(source.read(), { top: 40, height: 520 });
});
