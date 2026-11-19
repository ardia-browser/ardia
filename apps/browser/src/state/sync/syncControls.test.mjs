import assert from "node:assert/strict";
import { test } from "node:test";

const { syncControls } = await import("./syncControls.ts");

test("while paused Settings offers only Resume and Stop Syncing, and Stop can't delete the sync data", () => {
  assert.deepEqual(syncControls({ status: "paused", paused: true }), {
    primary: "resume",
    resuming: false,
    advanced: ["stop"],
    keyActions: false,
    editable: false,
    stopOffersDelete: false,
    stopOffersKit: false,
  });
});

test("mid-Resume only the busy Resume shows, whether or not the paused flag reached this window yet", () => {
  for (const paused of [true, false]) {
    const controls = syncControls({ status: "resuming", paused });
    assert.equal(controls.primary, "resume");
    assert.equal(controls.resuming, true);
    assert.deepEqual(controls.advanced, []);
    assert.equal(controls.editable, false);
  }
});

test("a Resume that needs the recovery phrase asks for it, still with only Stop beside it", () => {
  const controls = syncControls({ status: "locked", paused: true });
  assert.equal(controls.primary, "phrase");
  assert.deepEqual(controls.advanced, ["stop"]);
  assert.equal(controls.stopOffersDelete, false);
});

test("outside a pause Settings is as before", () => {
  assert.deepEqual(syncControls({ status: "updated", paused: false }), {
    primary: "connect",
    resuming: false,
    advanced: ["kit", "copy", "now", "reveal", "stop"],
    keyActions: true,
    editable: true,
    stopOffersDelete: true,
    stopOffersKit: true,
  });
  const locked = syncControls({ status: "locked", paused: false });
  assert.equal(locked.primary, "phrase");
  assert.equal(locked.keyActions, false, "the key actions are greyed out while locked, as before");
  assert.equal(locked.stopOffersDelete, true);
});
