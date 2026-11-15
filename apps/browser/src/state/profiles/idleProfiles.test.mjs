import assert from "node:assert/strict";
import { test } from "node:test";
import { idleProfiles, profileUnloadDelay } from "./idleProfiles.ts";

const FIVE = 5 * 60_000;

test("a profile must stay unshown for the whole delay", () => {
  const ready = idleProfiles();
  assert.deepEqual(ready(["work"], new Set(), 0, FIVE), []);
  assert.deepEqual(ready(["work"], new Set(), FIVE - 1, FIVE), []);
  assert.deepEqual(ready(["work"], new Set(), FIVE, FIVE), ["work"]);
  assert.deepEqual(ready(["work"], new Set(), FIVE + 60_000, FIVE), ["work"]);
});

test("being shown in any window starts the wait again", () => {
  const ready = idleProfiles();
  ready(["work", "play"], new Set(["play"]), 0, FIVE);
  assert.deepEqual(ready(["work", "play"], new Set(["work", "play"]), FIVE, FIVE), []);
  assert.deepEqual(ready(["work", "play"], new Set(["play"]), FIVE + 1, FIVE), []);
  assert.deepEqual(ready(["work", "play"], new Set(["play"]), 2 * FIVE + 1, FIVE), ["work"]);
});

test("a profile that unloaded and loaded again waits again", () => {
  const ready = idleProfiles();
  ready(["work"], new Set(), 0, FIVE);
  assert.deepEqual(ready(["work"], new Set(), FIVE, FIVE), ["work"]);
  ready([], new Set(), FIVE, FIVE);
  assert.deepEqual(ready(["work"], new Set(), FIVE + 1, FIVE), []);
});

test("turning unloading off forgets the time already waited", () => {
  const ready = idleProfiles();
  ready(["work"], new Set(), 0, FIVE);
  assert.deepEqual(ready(["work"], new Set(), FIVE, null), []);
  assert.deepEqual(ready(["work"], new Set(), FIVE + 1, FIVE), []);
  assert.deepEqual(ready(["work"], new Set(), 2 * FIVE + 1, FIVE), ["work"]);
});

test("the delay follows the setting, and Memory Saver off turns unloading off", () => {
  for (const [value, minutes] of [["never", null], ["5m", 5], ["15m", 15], ["1h", 60], ["2h", 120]]) {
    assert.equal(profileUnloadDelay({ memorySaver: true, unloadProfilesAfter: value }), minutes === null ? null : minutes * 60_000);
    assert.equal(profileUnloadDelay({ memorySaver: false, unloadProfilesAfter: value }), null);
  }
  assert.equal(profileUnloadDelay({ memorySaver: true, unloadProfilesAfter: "bogus" }), null);
});
