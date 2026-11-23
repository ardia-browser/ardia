import assert from "node:assert/strict";
import { test } from "node:test";

test("the 5 s fallback starts launch work but not work that waits for a window's root to really commit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { afterFirstWindow, afterFirstRoot, firstWindowCommitted } = await import("./afterFirstWindow.ts");
  const ran = [];
  afterFirstWindow(() => ran.push("window"));
  afterFirstRoot(() => ran.push("root"));
  t.mock.timers.tick(5000);
  t.mock.timers.tick(0);
  assert.deepEqual(ran, ["window"], "no window committed in 5 s: deferred launch work runs, root work keeps waiting");
  firstWindowCommitted();
  t.mock.timers.tick(0);
  assert.deepEqual(ran, ["window", "root"], "a window opened later, from the Dock say, starts it then");
  afterFirstRoot(() => ran.push("late"));
  t.mock.timers.tick(0);
  assert.deepEqual(ran, ["window", "root", "late"], "after the first root commit it runs at once");
});
