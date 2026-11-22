import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { useScrollEdge, useScrollEdgeBelow } = await import("./ScrollEdge.tsx");

test("a scroll edge tells its line the first time it shows, and only then", (t) => {
  const top = mount(() => useScrollEdge());
  t.after(() => top.unmount());
  let heard = 0;
  top.value.onSeen(() => heard++);
  top.value.follow(0);
  assert.equal(top.value.seen(), false, "a list at its top hides the edge: no line mounts at launch");
  top.value.follow(120);
  top.value.follow(0);
  top.value.follow(200);
  assert.equal(top.value.seen(), true);
  assert.equal(heard, 1);
  const below = mount(() => useScrollEdgeBelow());
  t.after(() => below.unmount());
  below.value.measure({ offset: 0, viewport: 600, content: 400 });
  assert.equal(below.value.seen(), false, "a list that fits never mounts its bottom line");
  below.value.measure({ content: 2000 });
  assert.equal(below.value.seen(), true);
});

test("the sidebar page's top edge sits out of the flow, so mounting it on need moves nothing", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /paddingBottom: edgeGap \+ SCROLL_EDGE\.line/);
  assert.match(page, /<ScrollEdgeLine edge=\{scrollEdge\} opacity=\{scrollEdge\.opacity\} style=\{\{ position: "absolute", left: 0, right: 0, bottom: edgeLift \}\} \/>/);
  assert.match(page, /<ScrollEdgeLine edge=\{scrollEdgeBelow\}/);
  assert.match(readFileSync(new URL("./ScrollEdge.tsx", import.meta.url), "utf8"), /if \(!seen\) return null;/);
});
