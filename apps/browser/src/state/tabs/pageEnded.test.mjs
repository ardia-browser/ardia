import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useMedia, hasPlayer, setNowPlaying } = await import("../media/media.ts");
const { pageEnded } = await import("./pageEvents.ts");
const { patchPage, pageOf } = await import("./pageState.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");

const playing = { title: "Song", artist: "", album: "", artwork: null, playbackState: "playing", controllable: true, hasVideo: false, position: 3, duration: 120, playbackRate: 1, timestamp: Date.now(), actions: [] };

test("a page that ends takes its Playing now card with it", () => {
  takeTabSleepCounts();
  setNowPlaying("pinned", playing);
  assert.equal(hasPlayer(useMedia.getState(), "pinned"), true);
  pageEnded("pinned");
  assert.equal(useMedia.getState().sessions.pinned, undefined);
  assert.equal(hasPlayer(useMedia.getState(), "pinned"), false);
  assert.equal(takeTabSleepCounts().media_cards_cleared, 1);
});

test("a page that ends with no media counts nothing and keeps the camera dot rule", () => {
  takeTabSleepCounts();
  patchPage("meet", { mediaAccess: { camera: true, microphone: false, screen: false } });
  pageEnded("meet");
  assert.equal(pageOf("meet").mediaAccess, null);
  const counts = takeTabSleepCounts();
  assert.equal(counts.media_cards_cleared, 0);
  assert.equal(counts.capture_indicators_cleared, 1);
});
