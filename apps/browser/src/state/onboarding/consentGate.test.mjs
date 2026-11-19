import assert from "node:assert/strict";
import { test } from "node:test";
const { CLOSED_GATE, consentShown, consentPressStarted, consentPressCounts } = await import("./consentGate.ts");

test("nothing confirms consent before its lines have finished appearing, not a click and not a key", () => {
  assert.equal(consentPressCounts(CLOSED_GATE), false);
  assert.equal(consentPressCounts(consentPressStarted(CLOSED_GATE, 10)), false);
});

test("a press that began before the lines were shown never counts, even when it ends after", () => {
  const pressedEarly = consentPressStarted(CLOSED_GATE, 100);
  assert.equal(consentPressCounts(consentShown(pressedEarly, 400)), false);
});

test("a fresh press after the lines were shown confirms", () => {
  const shown = consentShown(CLOSED_GATE, 400);
  assert.equal(consentPressCounts(consentPressStarted(shown, 401)), true);
  assert.equal(consentPressCounts(shown), true, "an accessibility press, with no pointer down, counts once shown");
});

test("the moment it was shown is kept from the first reveal", () => {
  const shown = consentShown(consentShown(CLOSED_GATE, 400), 900);
  assert.equal(shown.shownAt, 400);
});
