import assert from "node:assert/strict";
import { test } from "node:test";

const { userScrollClock } = await import("./userScrollClock.ts");
const { consentToken, setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
const { noteTabStripRevealHeldForScroll, takeTabStripCounts } = await import("../../state/telemetry/tabStripCounts.ts");

const held = () => takeTabStripCounts().tab_strip_reveals_held_for_scroll;

test("a strip scroll made with sharing off doesn't count a reveal it holds after sharing turns on", () => {
  let now = 0;
  const clock = userScrollClock(200, () => now);
  setConsentPeriod(false, null);
  clock.scrolled(now);
  setConsentPeriod(true, "strip-after");
  takeTabStripCounts();
  now = 50;
  assert.equal(clock.scrolling(), true);
  noteTabStripRevealHeldForScroll(clock.heldIn(consentToken()));
  noteTabStripRevealHeldForScroll(clock.heldIn());
  assert.equal(held(), 0);
});

test("a reveal that began with sharing off isn't counted as held by a scroll made after sharing turns on", () => {
  let now = 0;
  const clock = userScrollClock(200, () => now);
  setConsentPeriod(false, null);
  const revealStartedIn = consentToken();
  setConsentPeriod(true, "strip-later");
  clock.scrolled(now);
  takeTabStripCounts();
  noteTabStripRevealHeldForScroll(clock.heldIn(revealStartedIn));
  assert.equal(held(), 0);
});

test("a scroll and a reveal in the same sharing period count the hold, and the scroll goes quiet after its wait", () => {
  let now = 0;
  const clock = userScrollClock(200, () => now);
  setConsentPeriod(true, "strip-same");
  clock.scrolled(now);
  takeTabStripCounts();
  noteTabStripRevealHeldForScroll(clock.heldIn(consentToken()));
  noteTabStripRevealHeldForScroll(clock.heldIn());
  assert.equal(held(), 2);
  now = 250;
  assert.equal(clock.scrolling(), false);
});
