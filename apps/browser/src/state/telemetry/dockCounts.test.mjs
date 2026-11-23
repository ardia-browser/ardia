import assert from "node:assert/strict";
import { test } from "node:test";

const { FRAME_UNDER_OLD_PEEK_GAP, noteSidebarJumpHide, noteSidebarPeekFrame, takeDockCounts } = await import("./dockCounts.ts");

test("a peek on a frame thinner than the old 4 pt peek gap is counted, and the count resets once taken", () => {
  takeDockCounts();
  for (const inset of [0, 1, 2, 3, FRAME_UNDER_OLD_PEEK_GAP, 9, 12]) noteSidebarPeekFrame(inset);
  assert.equal(takeDockCounts().sidebar_thin_frame_peeks, 4);
  assert.equal(takeDockCounts().sidebar_thin_frame_peeks, 0);
});

test("a hide that doesn't slide is counted apart from the slides, and the count resets once taken", () => {
  takeDockCounts();
  noteSidebarJumpHide();
  const taken = takeDockCounts();
  assert.equal(taken.sidebar_jump_hides, 1);
  assert.equal(taken.sidebar_slides, 0);
  assert.equal(takeDockCounts().sidebar_jump_hides, 0);
});

test("a peek whose slide passed its final width counts only under the consent period it started in, and the count resets once taken", async () => {
  const { noteSidebarPeekPastTarget } = await import("./dockCounts.ts");
  const { consentToken, setConsentPeriod } = await import("./consentPeriod.ts");
  takeDockCounts();
  setConsentPeriod(true, "peek-on");
  const started = consentToken();
  noteSidebarPeekPastTarget(started);
  noteSidebarPeekPastTarget(null);
  setConsentPeriod(true, "peek-next");
  noteSidebarPeekPastTarget(started);
  setConsentPeriod(false, null);
  assert.equal(takeDockCounts().sidebar_peeks_past_target, 1);
  assert.equal(takeDockCounts().sidebar_peeks_past_target, 0);
});
