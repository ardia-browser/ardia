import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlowSlots, publishedForward } from "./sectionContext.ts";

test("forward runs only the handler the current question published", () => {
  const slots = createFlowSlots();
  const ran = [];
  slots.publish({ key: "layout.color", actions: null, preview: null });
  slots.forward.run = () => ran.push("color");
  assert.equal(publishedForward(slots, "layout.color"), slots.forward.run);
  assert.equal(publishedForward(slots, "layout.style"), null, "a move that lands before the next question publishes isn't run on the last one's handler");
  slots.publish({ key: "home.default:default", actions: null, preview: null });
  slots.forward.run = () => ran.push("default");
  assert.equal(publishedForward(slots, "home.default"), slots.forward.run, "a page inside the question still counts as that question");
  assert.equal(publishedForward(slots, "home"), null);
  assert.equal(publishedForward(slots, null), null);
  assert.deepEqual(ran, []);
});

test("a question that enables or disables its forward move tells whoever listens, once per change", () => {
  const slots = createFlowSlots();
  let told = 0;
  const stop = slots.subscribeForward(() => told++);
  slots.publish({ key: "source.source", actions: null, preview: null });
  assert.equal(publishedForward(slots, "source.source"), null);
  slots.forward.run = () => {};
  slots.forward.run = () => {};
  assert.equal(told, 1, "swapping one handler for another changes nothing a listener cares about");
  assert.notEqual(publishedForward(slots, "source.source"), null);
  slots.forward.run = null;
  assert.equal(told, 2);
  stop();
  slots.forward.run = () => {};
  assert.equal(told, 2);
});
