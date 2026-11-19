import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { launchGuardProperties, waitedForPreviousBucket, quitWaitBucket, LAUNCH_GUARD_DOC } = await import("./launchGuard.ts");

const reading = (contents) => (name) => (name === LAUNCH_GUARD_DOC ? contents : null);

test("the Windows engine's launch guard facts become app_launched properties", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":2875,"unfinishedStartsBefore":0,"restoreStateSetAside":false}')), {
    launch_waited_for_previous: "<3s",
    launch_unfinished_starts_before: 0,
    launch_restore_state_set_aside: false,
  });
});

test("a recovered stuck profile is reported with its unfinished starts", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":0,"unfinishedStartsBefore":2,"restoreStateSetAside":true}')), {
    launch_waited_for_previous: "0",
    launch_unfinished_starts_before: 2,
    launch_restore_state_set_aside: true,
  });
});

test("a start another Ardia still held the profile for is reported", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":45012,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"profileHeldByAnother":true}')), {
    launch_waited_for_previous: "45s+",
    launch_unfinished_starts_before: 0,
    launch_restore_state_set_aside: false,
    launch_profile_held_by_another: true,
  });
});

test("the wait for a previous Ardia is sent as a bucket, never in milliseconds", () => {
  assert.deepEqual(
    [0, 1, 999, 1000, 2999, 3000, 9999, 10_000, 29_999, 30_000, 44_999, 45_000, 120_000].map(waitedForPreviousBucket),
    ["0", "<1s", "<1s", "<3s", "<3s", "<10s", "<10s", "<30s", "<30s", "<45s", "<45s", "45s+", "45s+"],
  );
  const properties = launchGuardProperties(reading('{"waitedForPreviousMs":4321,"unfinishedStartsBefore":0,"restoreStateSetAside":false}'));
  assert.equal(properties.launch_waited_for_previous, "<10s");
  assert.ok(!Object.values(properties).includes(4321), "the raw wait is not sent");
});

test("a start made again after the closing Ardia turned the last launch away, and earlier refused starts, are reported", () => {
  assert.deepEqual(
    launchGuardProperties(reading('{"waitedForPreviousMs":0,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"profileHeldByAnother":false,"refusedStartsBefore":3,"restartedAfterRefusal":true}')),
    {
      launch_waited_for_previous: "0",
      launch_unfinished_starts_before: 0,
      launch_restore_state_set_aside: false,
      launch_profile_held_by_another: false,
      launch_refused_starts_before: 3,
      launch_restarted_after_refusal: true,
    },
  );
});

test("the last quit's wait for the app's answer is sent as a range with its answer, reason and the quits a launch cancelled", () => {
  assert.deepEqual(
    [0, 99, 100, 499, 500, 999, 1000, 1999, 2000, 2999, 3000, 15_000].map(quitWaitBucket),
    ["<100ms", "<100ms", "<500ms", "<500ms", "<1s", "<1s", "<2s", "<2s", "<3s", "<3s", "3s+", "3s+"],
  );
  const properties = launchGuardProperties(
    reading('{"waitedForPreviousMs":0,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"lastQuitWaitMs":2875,"lastQuitAnswer":"yes","lastQuitReason":"user","quitsCancelledByLaunch":2}'),
  );
  assert.equal(properties.launch_last_quit_wait, "<3s");
  assert.equal(properties.launch_last_quit_answer, "yes");
  assert.equal(properties.launch_last_quit_reason, "user");
  assert.equal(properties.launch_quits_cancelled_by_launch, 2);
  assert.ok(!Object.values(properties).includes(2875), "the raw wait is not sent");
  assert.equal(launchGuardProperties(reading('{"lastQuitWaitMs":3000,"lastQuitAnswer":"timeout","lastQuitReason":"update"}')).launch_last_quit_wait, "3s+");
});

test("an unknown quit answer or reason, or a wait without an answer, adds no quit properties", () => {
  for (const quit of ['"lastQuitWaitMs":10,"lastQuitAnswer":"maybe"', '"lastQuitWaitMs":10', '"lastQuitAnswer":"yes"', '"lastQuitWaitMs":-5,"lastQuitAnswer":"yes"']) {
    const properties = launchGuardProperties(reading(`{${quit},"quitsCancelledByLaunch":1}`));
    assert.equal(properties.launch_last_quit_wait, undefined, quit);
    assert.equal(properties.launch_last_quit_answer, undefined, quit);
    assert.equal(properties.launch_quits_cancelled_by_launch, undefined, quit);
  }
  const unknownReason = launchGuardProperties(reading('{"lastQuitWaitMs":10,"lastQuitAnswer":"yes","lastQuitReason":"restart"}'));
  assert.equal(unknownReason.launch_last_quit_answer, "yes");
  assert.equal(unknownReason.launch_last_quit_reason, undefined);
});

test("no file, a broken file or odd values add nothing", () => {
  assert.deepEqual(launchGuardProperties(reading(null)), {});
  assert.deepEqual(launchGuardProperties(reading("{not json")), {});
  assert.deepEqual(launchGuardProperties(reading("[]")), {});
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":-4,"unfinishedStartsBefore":"2","restoreStateSetAside":"yes","profileHeldByAnother":1,"refusedStartsBefore":-1,"restartedAfterRefusal":"yes","lastQuitWaitMs":"9","lastQuitAnswer":7}')), {});
  assert.deepEqual(launchGuardProperties(() => { throw new Error("no documents"); }), {});
});
