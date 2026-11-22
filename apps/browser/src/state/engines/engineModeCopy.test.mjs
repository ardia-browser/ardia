import assert from "node:assert/strict";
import { test } from "node:test";

const { engineModeFooter } = await import("./engineModeCopy.ts");

const facts = { mode: "automatic", switching: false, defaultEngine: "chromium", streamingInWebKit: true, webKitExtensions: true };

test("the Engine footer says what the current choice does, and only what applies", () => {
  assert.equal(engineModeFooter(facts), "Most pages open in Chromium. Streaming sites open in WebKit to play protected video.");
  assert.equal(engineModeFooter({ ...facts, streamingInWebKit: false }), "Most pages open in Chromium.");
  assert.equal(engineModeFooter({ ...facts, defaultEngine: "webkit" }), "Most pages open in WebKit.");
  assert.match(engineModeFooter({ ...facts, mode: "chromium" }), /protected video won't play/);
  assert.doesNotMatch(engineModeFooter({ ...facts, mode: "webkit" }), /without extensions/);
  assert.match(engineModeFooter({ ...facts, mode: "webkit", webKitExtensions: false }), /without extensions on this version of macOS/);
  assert.equal(engineModeFooter({ ...facts, mode: "webkit", switching: true }), "Switching…");
});
