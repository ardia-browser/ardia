import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { world, regionsOf } = await import("./fixtures/dragWorld.mjs");
const { entryKey, sceneLayout, mount, readDrag, settle } = D;

function listScene() {
  const W = world("a", "b", "c", "d");
  const L = sceneLayout({ top: 60 });
  const listTop = L.y;
  L.row(W.id.a).row(W.id.b).row(W.id.c).tail("list");
  return { ...W, L, regions: regionsOf(L, { list: [listTop, L.y] }) };
}

const frameOf = (m, id) => m.L.entries.find((e) => e.key === entryKey("tab", id)).frame;

test("a drag lets the launch's held rows in before it measures its targets, from inside the sidebar and from outside", async () => {
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const order = [];
  c.beforeMeasure = () => order.push(`release while ${c.root.held ? "held" : "free"}`);
  c.root.held = true;
  const b = frameOf(m, m.id.b);
  const internal = c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  assert.deepEqual(order, ["release while held"], "released before the measure resolves");
  c.root.release();
  await internal;
  await c.end(false);
  c.root.held = true;
  const external = c.beginExternal(1, 60, 300);
  assert.equal(order.length, 2);
  c.root.release();
  await external;
  c.finishExternal(false);
});

test("a row that mounts during a drag isn't measured into it: the targets and the drop stay as the drag measured them", async () => {
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  await c.beginExternal(1, 60, 300);
  const b = frameOf(m, m.id.b);
  c.move(60, b.y + 2);
  const before = readDrag(c);
  const late = c.create(entryKey("tab", m.id.d));
  late.view = null;
  c.items.set(late.key, late);
  await settle();
  c.move(60, b.y + 2);
  assert.deepEqual(readDrag(c), before);
  assert.equal(late.frame, null);
  assert.notEqual(c.finishExternal(true), null);
});
