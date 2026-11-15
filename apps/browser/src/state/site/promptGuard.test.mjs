import assert from "node:assert/strict";
import { test } from "node:test";
import { windows } from "../../test-native/shell.ts";

const { watchWindowActivation, windowActivatedAt } = await import("./promptGuard.ts");

test("a window that becomes key counts as an activation; the keyboard coming back from its own page window doesn't", async () => {
  watchWindowActivation();
  windows.emit({ type: "focus", id: "w1" });
  const fromOtherWindow = windowActivatedAt();
  assert.ok(fromOtherWindow > 0, "a window becoming key is an activation");
  await new Promise((resolve) => setTimeout(resolve, 5));
  windows.emit({ type: "focus", id: "w1", fromPage: true });
  assert.equal(windowActivatedAt(), fromOtherWindow, "focus back from one of the window's own pages");
  windows.emit({ type: "focus", id: "w2" });
  assert.ok(windowActivatedAt() > fromOtherWindow, "another window becoming key still counts");
});
