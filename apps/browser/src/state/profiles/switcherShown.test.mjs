import assert from "node:assert/strict";
import { test } from "node:test";
const { profileSwitcherShown } = await import("./switcherShown.ts");

test("the profile switcher shows only with several profiles, outside Incognito, unless the owner picked Nothing", () => {
  assert.equal(profileSwitcherShown({ showProfileDots: true }, 2, false), true);
  assert.equal(profileSwitcherShown({ showProfileDots: false }, 2, false), false);
  assert.equal(profileSwitcherShown({ showProfileDots: true }, 1, false), false);
  assert.equal(profileSwitcherShown({ showProfileDots: true }, 3, true), false);
});
