import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { launchGuardProperties, LAUNCH_GUARD_DOC } = await import("./diagnostics.ts");

const reading = (contents) => (name) => (name === LAUNCH_GUARD_DOC ? contents : null);

test("the Windows engine's launch guard facts become app_launched properties", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":2875,"unfinishedStartsBefore":0,"restoreStateSetAside":false}')), {
    launch_waited_for_previous_ms: 2875,
    launch_unfinished_starts_before: 0,
    launch_restore_state_set_aside: false,
  });
});

test("a recovered stuck profile is reported with its unfinished starts", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":0,"unfinishedStartsBefore":2,"restoreStateSetAside":true}')), {
    launch_waited_for_previous_ms: 0,
    launch_unfinished_starts_before: 2,
    launch_restore_state_set_aside: true,
  });
});

test("a start another Ardia still held the profile for is reported", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":45012,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"profileHeldByAnother":true}')), {
    launch_waited_for_previous_ms: 45012,
    launch_unfinished_starts_before: 0,
    launch_restore_state_set_aside: false,
    launch_profile_held_by_another: true,
  });
});

test("no file, a broken file or odd values add nothing", () => {
  assert.deepEqual(launchGuardProperties(reading(null)), {});
  assert.deepEqual(launchGuardProperties(reading("{not json")), {});
  assert.deepEqual(launchGuardProperties(reading("[]")), {});
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":-4,"unfinishedStartsBefore":"2","restoreStateSetAside":"yes","profileHeldByAnother":1}')), {});
  assert.deepEqual(launchGuardProperties(() => { throw new Error("no documents"); }), {});
});
