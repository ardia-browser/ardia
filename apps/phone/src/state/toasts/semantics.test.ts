import assert from "node:assert/strict";
import { test } from "node:test";
import { dismissesToast, toastAnnouncement, toastDragReturn, toastSemantics, toastSpokenLabel } from "./semantics.ts";

test("a toast with an action is a button; one without is an alert, never a button whose tap only hides it", () => {
  assert.deepEqual([toastSemantics("Open", "ios").pressable, toastSemantics("Open", "ios").role], [true, "button"]);
  assert.deepEqual([toastSemantics(null, "android").pressable, toastSemantics(null, "android").role], [false, "alert"]);
});

test("each phone announces a toast one way: iPhone through an announcement, Android through a live region", () => {
  assert.deepEqual([toastSemantics(null, "ios").announcement, toastSemantics(null, "ios").liveRegion], ["announceForAccessibility", "none"]);
  assert.deepEqual([toastSemantics("Open", "android").announcement, toastSemantics("Open", "android").liveRegion], ["liveRegion", "polite"]);
});

test("swipe-to-dismiss has one named Close action and the system's two-finger escape, on every toast; no unnamed escape action", () => {
  for (const actionable of ["Open", null]) {
    const { actions, escapes } = toastSemantics(actionable, "ios");
    assert.deepEqual(actions, [{ name: "dismiss", label: "Close" }]);
    assert.equal(escapes, true);
  }
  assert.equal(dismissesToast("dismiss"), true);
  assert.equal(dismissesToast("escape"), false);
  assert.equal(dismissesToast("activate"), false);
});

test("with Reduce Motion a dragged toast snaps back instead of springing", () => {
  assert.equal(toastDragReturn(true), "snap");
  assert.equal(toastDragReturn(false), "spring");
});

test("an actionable toast is spoken with what its action does; one without an action is spoken as its message", () => {
  assert.equal(toastSpokenLabel("Downloaded otter.pdf", "Open"), "Downloaded otter.pdf, Open");
  assert.equal(toastSpokenLabel("Copied Link", null), "Copied Link");
});

test("an actionable toast arrives as one announcement that names its action", () => {
  assert.equal(toastAnnouncement("Downloaded otter.pdf", "Open"), "Downloaded otter.pdf, Open");
  assert.equal(toastAnnouncement("Copied Link", null), "Copied Link");
});
