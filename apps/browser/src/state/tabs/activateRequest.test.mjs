import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { answerActivateRequest } = await import("./activateRequest.ts");
const { takePictureInPictureCounts } = await import("../telemetry/pictureInPictureCounts.ts");
const { focusedWindowOf } = await import("../windows/ui.ts");

const S = () => useBrowser.getState();
const tab = (id, windowId) => ({
  id, windowId, profileId: "default", url: `https://${id}.com/`, title: "", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null,
  customIcon: null, pinnedUrl: null, page: { kind: "loaded", nav: { url: `https://${id}.com/`, seq: 1 } }, openerId: null, createdAt: 0, lastActiveAt: 0,
});
const win = (id, tabIds, active) => ({
  id, profileId: "default", kind: "main", tabIds, activeTabIds: { default: active }, sidebarOpen: true, frame: null, createdAt: 0,
});
const PROFILES = { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } };
const setup = () => {
  const tabs = [tab("video", "w1"), tab("notes", "w1"), tab("other", "w2")];
  S().hydrate({
    profiles: PROFILES,
    windows: { w1: win("w1", ["video", "notes"], "notes"), w2: win("w2", ["other"], "other") },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
  });
  S().setFocusedWindow("w2");
  takePictureInPictureCounts();
};
const selected = (windowId) => S().windows[windowId].activeTabIds.default;

test("a window activation that names the tab you just left brings the window forward and keeps your tab selected", () => {
  setup();
  answerActivateRequest("video", "window", "chromium");
  assert.equal(selected("w1"), "notes", "the video's tab doesn't come back, so its automatic Picture in Picture stays open");
  assert.equal(focusedWindowOf(S()), "w1");
  assert.deepEqual(takePictureInPictureCounts().windowActivations, { requests: 1, keptTab: 1 });
});

test("a window activation that names the selected tab only brings the window forward", () => {
  setup();
  answerActivateRequest("notes", "window", "chromium");
  assert.equal(selected("w1"), "notes");
  assert.equal(focusedWindowOf(S()), "w1");
  assert.deepEqual(takePictureInPictureCounts().windowActivations, { requests: 1, keptTab: 0 });
});

test("a page asking for its tab, and Back to Tab from Picture in Picture, still switch to that tab", () => {
  setup();
  answerActivateRequest("video", "page", "chromium");
  assert.equal(selected("w1"), "video");
  setup();
  answerActivateRequest("video", "pictureInPicture", "webkit");
  assert.equal(selected("w1"), "video");
  assert.equal(focusedWindowOf(S()), "w1");
  const counts = takePictureInPictureCounts();
  assert.deepEqual(counts.backToTab, { chromium: 0, webkit: 1 });
  assert.deepEqual(counts.windowActivations, { requests: 0, keptTab: 0 });
});

test("a request from a tab that is gone does nothing", () => {
  setup();
  answerActivateRequest("gone", "window", "chromium");
  answerActivateRequest("gone", "page", "chromium");
  assert.equal(selected("w1"), "notes");
  assert.equal(focusedWindowOf(S()), "w2");
});
