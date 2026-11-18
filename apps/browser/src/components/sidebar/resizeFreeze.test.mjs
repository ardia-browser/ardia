import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { freezeOffscreenRows, thawRows } = await import("./resizeFreeze.ts");

function view(frame, log, name) {
  return {
    measureInWindow: (done) => queueMicrotask(() => done(frame.x, frame.y, frame.w, frame.h)),
    setNativeProps: (props) => log.push([name, props.style.width]),
  };
}

function page(log) {
  const items = new Map();
  const entry = (key, y, spec = {}) => items.set(key, { key, kind: "row", tabIds: [], section: "list", ...spec, view: view({ x: 12, y, w: 218, h: 34 }, log, key) });
  entry("above", 20);
  entry("top", 110);
  entry("shown", 400);
  entry("bottom", 780);
  entry("below", 1600);
  entry("far", 2600, { kind: "group", groupId: "g" });
  entry("member", 2650, { parentGroup: "g" });
  entry("tile", 2700, { kind: "tile" });
  return { items, scroll: view({ x: 0, y: 100, w: 242, h: 700 }, log, "scroll") };
}

test("a resize freezes the entries outside the list's viewport and its margin at their width, and thaws them after", async () => {
  const log = [];
  const controller = page(log);
  await freezeOffscreenRows(controller);
  assert.deepEqual(log.sort(), [["below", 218], ["far", 218]]);
  log.length = 0;
  thawRows(controller);
  assert.deepEqual(log.sort(), [["below", null], ["far", null]]);
  log.length = 0;
  thawRows(controller);
  assert.deepEqual(log, []);
});

test("rows a group or the pinned grid hold, and the grid's tiles, are never frozen on their own", async () => {
  const log = [];
  await freezeOffscreenRows(page(log));
  assert.ok(!log.some(([name]) => name === "member" || name === "tile"));
});

test("a resize that ends before the entries are measured freezes nothing", async () => {
  const log = [];
  const controller = page(log);
  const freezing = freezeOffscreenRows(controller);
  thawRows(controller);
  await freezing;
  assert.deepEqual(log, []);
});

test("an entry whose ref let go while frozen, as when its page stops being the shown one mid-drag, still gets its width back", async () => {
  const log = [];
  const controller = page(log);
  await freezeOffscreenRows(controller);
  controller.items.get("below").view = null;
  log.length = 0;
  thawRows(controller);
  assert.deepEqual(log.sort(), [["below", null], ["far", null]]);
});
