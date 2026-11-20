import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorView, registerAnchor, whenAnchorMounts } from "./anchors.ts";

test("a reveal waiting for a row hears when it mounts, once it's registered", () => {
  const heard = [];
  const stop = whenAnchorMounts("general.defaultBrowser", (view) => heard.push(view));
  const view = { id: "row" };
  const unregister = registerAnchor("general.defaultBrowser", view);
  assert.deepEqual(heard, [view]);
  assert.equal(anchorView("general.defaultBrowser"), view);
  stop();
  unregister();
  registerAnchor("general.defaultBrowser", { id: "again" })();
  assert.equal(heard.length, 1);
});

test("a cancelled wait hears nothing, and other rows don't wake it", () => {
  const heard = [];
  const stop = whenAnchorMounts("tabs.layout", () => heard.push("layout"));
  registerAnchor("tabs.sidebarSide", {})();
  stop();
  registerAnchor("tabs.layout", {})();
  assert.deepEqual(heard, []);
});
