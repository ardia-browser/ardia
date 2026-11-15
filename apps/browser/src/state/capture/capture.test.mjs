import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { webviewRef } = await import("../../platform/webviews.ts");
const { closeCaptureOnEscape, endCapture, finishCapture, runCaptureCommand, useCapture } = await import("./capture.ts");
const { takeCaptureCounts } = await import("../telemetry/captureCounts.ts");

const S = () => useBrowser.getState();
const capturing = () => useCapture.getState().windowId;

function setup(url = "https://page.example/") {
  S().hydrate({});
  useCapture.setState({ windowId: null });
  takeCaptureCounts();
  const w = S().createWindow({ url });
  const t = S().windows[w].tabIds[0];
  S().updateTab(t, { url });
  const calls = { copies: [], focuses: 0 };
  webviewRef(t)({
    focus: () => void calls.focuses++,
    copyRegionToPasteboard: (rect) => {
      calls.copies.push(rect);
      return Promise.resolve({ width: rect[2] * 2, height: rect[3] * 2 });
    },
  });
  return { w, t, calls };
}

test("the command starts a capture in its window, and again ends it and gives the page back its focus", () => {
  const { w, calls } = setup();
  assert.equal(runCaptureCommand("reload", w), false);
  assert.equal(runCaptureCommand("capture", w), true);
  assert.equal(capturing(), w);
  runCaptureCommand("capture", w);
  assert.equal(capturing(), null);
  assert.equal(calls.focuses, 1);
  assert.deepEqual(takeCaptureCounts(), { capture_starts: 1, capture_copies: 0, capture_copies_in_split: 0, capture_cancels: 1, capture_failures: 0 });
});

test("no capture over a Peek or an internal page", () => {
  const { w, t } = setup();
  assert.ok(S().openPeek(t, "https://peek.example/"));
  runCaptureCommand("capture", w);
  assert.equal(capturing(), null);
  const other = setup("ardia://history");
  runCaptureCommand("capture", other.w);
  assert.equal(capturing(), null);
});

test("a drag copies the area of the pane under it in window points, from the card's origin", async () => {
  const { w, t, calls } = setup();
  runCaptureCommand("capture", w);
  await finishCapture(w, { x: 100, y: 80, width: 200, height: 120 }, { [t]: { x: 0, y: 0, width: 1000, height: 700 } }, { x: 9, y: 40 });
  assert.equal(capturing(), null);
  assert.deepEqual(calls.copies, [[109, 120, 200, 120]]);
  assert.equal(takeCaptureCounts().capture_copies, 1);
});

test("a click copies nothing, a tab switch ends it without moving focus, and Esc from the page ends it", async () => {
  const { w, t, calls } = setup();
  runCaptureCommand("capture", w);
  await finishCapture(w, { x: 10, y: 10, width: 0, height: 0 }, { [t]: { x: 0, y: 0, width: 1000, height: 700 } }, { x: 0, y: 0 });
  assert.deepEqual(calls.copies, []);
  runCaptureCommand("capture", w);
  const focused = calls.focuses;
  endCapture(w, { refocus: false });
  assert.equal(calls.focuses, focused);
  assert.equal(closeCaptureOnEscape(t), false);
  runCaptureCommand("capture", w);
  assert.equal(closeCaptureOnEscape(t), true);
  assert.equal(capturing(), null);
  assert.equal(takeCaptureCounts().capture_cancels, 3);
});
