import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { dismissToast, holdToast, showToast, TOAST_RELEASE_MS, useToasts } from "./store.ts";

test("the same message shown again keeps the toast and only extends its time, as Compose's ToastCenter does", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    showToast("Copied URL", "link", 2400);
    const first = useToasts.getState().toast!.id;
    mock.timers.tick(2000);
    showToast("Copied URL", "link", 2400);
    assert.equal(useToasts.getState().toast!.id, first, "no new toast, so no new entrance");
    mock.timers.tick(2000);
    assert.equal(useToasts.getState().toast?.id, first);
    mock.timers.tick(500);
    assert.equal(useToasts.getState().toast, null);
    showToast("Sent to Mac", "sent", 2400);
    const second = useToasts.getState().toast!.id;
    showToast("Pinned to Your Mac", "star", 2400);
    assert.notEqual(useToasts.getState().toast!.id, second);
  } finally {
    dismissToast();
    mock.timers.reset();
  }
});

test("a finger on the toast holds it, and letting go gives it 1.2 s more", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    showToast("Tab from MacBook Pro", "laptop", 2400);
    holdToast(true);
    mock.timers.tick(10_000);
    assert.ok(useToasts.getState().toast);
    holdToast(false);
    mock.timers.tick(TOAST_RELEASE_MS - 1);
    assert.ok(useToasts.getState().toast);
    mock.timers.tick(1);
    assert.equal(useToasts.getState().toast, null);
  } finally {
    dismissToast();
    mock.timers.reset();
  }
});
