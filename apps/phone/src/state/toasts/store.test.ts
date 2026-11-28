import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { currentToastKey, dismissToast, holdToast, showToast, TOAST_ACTION_DURATION_MS, TOAST_DURATION_MS, TOAST_RELEASE_MS, toastDuration, useToasts } from "./store.ts";

test("the same message shown again keeps the toast and only extends its time, as Compose's ToastCenter does", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    showToast("Copied Link", "link", 2400);
    const first = useToasts.getState().toast!.id;
    mock.timers.tick(2000);
    showToast("Copied Link", "link", 2400);
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

test("an old single-string toast becomes a card whose title is the message, on a neutral icon tile, with no detail", () => {
  try {
    showToast("Copied Link", "link");
    const toast = useToasts.getState().toast!;
    assert.equal(toast.title, "Copied Link");
    assert.equal(toast.message, "Copied Link");
    assert.equal(toast.detail, null);
    assert.deepEqual(toast.tile, { kind: "icon", icon: "link" });
    assert.equal(toast.durationMs, TOAST_DURATION_MS);
    assert.equal(toast.titleLines, 3);
  } finally {
    dismissToast();
  }
});

test("a card stays 2.4 s plain and about 5 s once it has an action, even when a caller asked for less", () => {
  assert.equal(toastDuration(undefined, null), 2400);
  assert.equal(toastDuration(undefined, { label: "Open", run: () => undefined }), TOAST_ACTION_DURATION_MS);
  assert.equal(toastDuration(3200, { label: "Open", run: () => undefined }), TOAST_ACTION_DURATION_MS);
  assert.equal(toastDuration(3200, null), 3200);
});

test("a later card with the same key updates the visible one in place: same id, so no exit or entrance, new text, a fresh clock", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    showToast({ key: "download:7", title: "Couldn’t download otter.pdf", detail: "Check your connection and try again.", tile: { kind: "icon", icon: "warning" }, titleLines: 2, action: { label: "Retry", run: () => undefined } });
    const first = useToasts.getState().toast!;
    assert.equal(first.titleLines, 2);
    assert.equal(first.middleTruncates, false);
    mock.timers.tick(4000);
    showToast({ key: "download:7", title: "otter.pdf", detail: "Downloaded · 1.2 MB", tile: { kind: "file", ext: "pdf" }, action: { label: "Open", run: () => undefined } });
    const done = useToasts.getState().toast!;
    assert.equal(done.id, first.id);
    assert.equal(done.detail, "Downloaded · 1.2 MB");
    assert.equal(done.middleTruncates, true);
    assert.equal(currentToastKey(), "download:7");
    mock.timers.tick(TOAST_ACTION_DURATION_MS - 1);
    assert.ok(useToasts.getState().toast);
    mock.timers.tick(1);
    assert.equal(useToasts.getState().toast, null);
    assert.equal(currentToastKey(), null);
  } finally {
    dismissToast();
    mock.timers.reset();
  }
});

test("a card is spoken as its title and detail unless it names its own spoken words", () => {
  try {
    showToast({ title: "Cleared Browsing Data", detail: "History · Last Hour" });
    assert.equal(useToasts.getState().toast!.spoken, "Cleared Browsing Data, History · Last Hour");
    showToast({ title: "2 downloads complete", detail: "a.pdf, b.zip", spoken: "2 downloads complete" });
    assert.equal(useToasts.getState().toast!.spoken, "2 downloads complete");
  } finally {
    dismissToast();
  }
});
