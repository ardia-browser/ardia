import assert from "node:assert/strict";
import test from "node:test";
import { followButtonLayout, WINDOWS_BUTTON_LAYOUT } from "../buttonLayout.win.ts";
import { parseButtonLayout } from "../../../../browser/src/lib/windowButtonLayout.ts";

test("Windows puts minimize, maximize and close on the right at once, without asking the host or reading a remembered GTK layout", () => {
  const calls = [];
  const host = { invoke: () => assert.fail("the Windows layout never asks the host"), onEvent: () => assert.fail("the Windows layout never listens for changes") };
  const stop = followButtonLayout(host, (layout, tiling) => calls.push([layout, tiling]));
  assert.deepEqual(calls, [[WINDOWS_BUTTON_LAYOUT, false]]);
  assert.equal(typeof stop, "function");
  stop();
  const layout = parseButtonLayout(WINDOWS_BUTTON_LAYOUT);
  assert.deepEqual(layout, parseButtonLayout(":minimize,maximize,close"));
});
