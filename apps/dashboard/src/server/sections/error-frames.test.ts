import { test } from "node:test";
import assert from "node:assert/strict";
import { framesOf, POSTED_TASK_LABEL } from "./error-frames.ts";

const frame = (fn: string) => ({ function: fn, filename: "Chromium Framework", module: "Chromium Framework" });

test("a crash's own 40 frames come first and the posting frames follow under their label, none of the crash's dropped", () => {
  const crash = Array.from({ length: 40 }, (_, i) => frame(`crash ${i}`));
  const posted = [frame("posted outer"), frame("posted inner")];
  const list = JSON.stringify([
    { type: "EXC_BREAKPOINT", stacktrace: { frames: crash } },
    { type: "PostedTask", stacktrace: { frames: posted } },
  ]);
  const shown = framesOf(list).map((f) => f.fn);
  assert.equal(shown.length, 43);
  assert.deepEqual(shown.slice(0, 40), crash.map((f) => f.function).reverse());
  assert.deepEqual(shown.slice(40), [POSTED_TASK_LABEL, "posted inner", "posted outer"]);
});

test("a crash without posting frames reads as before, with no label", () => {
  const list = JSON.stringify([{ type: "Crash", stacktrace: { frames: [frame("outer"), frame("inner")] } }]);
  assert.deepEqual(framesOf(list).map((f) => f.fn), ["inner", "outer"]);
});
