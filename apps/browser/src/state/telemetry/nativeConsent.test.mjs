import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const { nativeConsent } = await import("./nativeConsent.ts");
const diagnostics = await import("./diagnostics.ts");
const media = await import("../media/media.ts");
const cursor = await import("./pageCursorCounts.ts");
const placement = await import("./windowPlacementCounts.ts");
const motion = await import("../../platform/motion.ts");
const bursts = await import("./animationBursts.ts");
const pip = await import("./pictureInPictureCounts.ts");
const popup = await import("./popupProtectedMedia.ts");
const { flushLocal } = await import("./localStore.ts");
after(() => client.setSharing(false, "settings"));

client.loadChoice();
client.setSharing(true, "onboarding");

const staleEpoch = () => {
  const stale = client.consentEpoch();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  assert.notEqual(client.consentEpoch(), stale);
  return stale;
};

async function queued(event) {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === event).map((e) => e.properties);
}

async function local(event, match = () => true) {
  await flushLocal();
  return stub.telemetryLocal.records().filter((r) => r.event === event && match(r.properties ?? {}));
}

const episode = { reason: "halfActive", trigger: "move", keyWindow: "browser", mainWindow: "browser", preventKey: false, canKey: true, windowMain: true, halfActive: true, appActive: true, runningActive: false, frontmost: true, menuActive: false, overPage: true, cover: "none", coverClear: true, healed: false, healWorked: null, endedBy: "hover", episode: 1 };

test("a native record's epoch is its consent token; a missing, empty or non-string epoch is no token", () => {
  assert.equal(nativeConsent({ epoch: "period-1" }), "period-1");
  for (const record of [{}, { epoch: "" }, { epoch: 7 }, { epoch: null }, null, undefined]) assert.equal(nativeConsent(record), null);
});

test("thread 1: a lost-hover episode that began in an earlier consent period, or carries no epoch, stays in the local copy", async () => {
  const stale = staleEpoch();
  diagnostics.trackHoverLost({ ...episode, seconds: 41, epoch: stale });
  diagnostics.trackHoverLost({ ...episode, seconds: 42 });
  diagnostics.trackHoverLost({ ...episode, seconds: 43, epoch: client.consentEpoch() });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual((await queued("page_hover_lost")).map((p) => p.lost_seconds), [43]);
  const kept = await local("page_hover_lost", (p) => p.lost_seconds === 41 || p.lost_seconds === 42);
  assert.deepEqual(kept.map((r) => [r.properties.lost_seconds, r.sent]), [[41, false], [42, false]]);
});

test("thread 3: a Picture in Picture window shown after a retry that began in an earlier consent period is never sent", async () => {
  const stale = staleEpoch();
  media.setPictureInPictureState("pip-stale", { kind: "document", active: true, fullScreenSpaces: true, leftApp: false, leftTab: true, epoch: stale });
  media.setPictureInPictureState("pip-missing", { kind: "video", active: true, fullScreenSpaces: false, leftApp: true, leftTab: false });
  media.setPictureInPictureState("pip-now", { kind: "video", active: true, fullScreenSpaces: true, leftApp: true, leftTab: true, epoch: client.consentEpoch() });
  assert.deepEqual((await queued("pip_shown")).map((p) => [p.kind, p.left_app, p.left_tab]), [["video", true, true]]);
  assert.deepEqual((await local("pip_shown")).filter((r) => !r.sent).map((r) => r.properties.kind), ["document", "video"]);
});

test("a pointer restore from an earlier consent period, or with no epoch, isn't counted for this one and stays in the local copy", async () => {
  cursor.takePageCursorCounts();
  const stale = staleEpoch();
  stub.emitEvent("engine.cursorRestored", { hidden: true, epoch: stale });
  stub.emitEvent("engine.cursorRestored", { hidden: false });
  stub.emitEvent("engine.cursorRestored", { hidden: true, epoch: client.consentEpoch() });
  assert.deepEqual(cursor.takePageCursorCounts(), { page_pointer_restores: 1, page_pointer_hidden_restores: 1 });
  const kept = await local("usage_counts", (p) => p.page_pointer_restores === 1);
  assert.deepEqual(kept.map((r) => [r.properties.page_pointer_hidden_restores, r.sent]), [[1, false], [0, false]]);
});

test("window placement events from an earlier consent period, or with no epoch, aren't counted for this one and stay in the local copy", async () => {
  placement.takeWindowPlacementCounts();
  const stale = staleEpoch();
  stub.emitAppEvent({ type: "centeredResize", epoch: stale });
  stub.emitAppEvent({ type: "windowDragLoop", epoch: stale });
  stub.emitAppEvent({ type: "windowTitleRead" });
  stub.emitAppEvent({ type: "windowDragLoop", epoch: client.consentEpoch() });
  assert.deepEqual(placement.takeWindowPlacementCounts(), { window_centered_resizes: 0, windows_reopened_maximized: 0, window_titles_read: 0, window_drag_loops: 1, window_close_pins_kept: 0 });
  const kept = await local("usage_counts", (p) => p.window_centered_resizes === 1 || p.window_drag_loops === 1 || p.window_titles_read === 1);
  assert.deepEqual(kept.map((r) => [Object.keys(r.properties).find((k) => k.startsWith("window")), r.sent]).filter(([k]) => k), [["window_centered_resizes", false], ["window_drag_loops", false], ["window_titles_read", false]]);
});

test("an animation burst that began in an earlier consent period isn't counted for this one and stays in the local copy", async () => {
  let listen = () => {};
  motion.animationBursts.onBurst = (listener) => ((listen = listener), () => {});
  bursts.watchAnimationBursts();
  bursts.takeAnimationBursts();
  const stale = staleEpoch();
  listen({ frames: 30, milliseconds: 500, longest: 40, long: 3, epoch: stale });
  listen({ frames: 30, milliseconds: 500, longest: 40, long: 5 });
  listen({ frames: 30, milliseconds: 500, longest: 40, long: 2, epoch: client.consentEpoch() });
  assert.deepEqual(bursts.takeAnimationBursts(), { animation_bursts: 1, animation_long_frames: 2 });
  const kept = await local("usage_counts", (p) => p.animation_bursts === 1);
  assert.deepEqual(kept.map((r) => [r.properties.animation_long_frames, r.sent]), [[3, false], [5, false]]);
});

test("Picture in Picture drags and click skips from an earlier consent period aren't counted for this one and stay in the local copy", async () => {
  pip.takePictureInPictureCounts();
  const stale = staleEpoch();
  pip.notePictureInPictureDragged({ offCursor: true, slowMove: false, epoch: stale });
  pip.notePictureInPictureDragged({ offCursor: false, slowMove: true });
  pip.notePictureInPictureDragged({ offCursor: true, slowMove: true, epoch: client.consentEpoch() });
  pip.notePictureInPictureClickSkip({ seconds: -10, epoch: stale });
  pip.notePictureInPictureClickSkip({ seconds: 10, epoch: client.consentEpoch() });
  const taken = pip.takePictureInPictureCounts();
  assert.deepEqual([taken.drags, taken.clickSkips], [{ moved: 1, offCursor: 1, slowMove: 1 }, { back: 0, ahead: 1 }]);
  const drags = await local("usage_counts", (p) => p.pip_drags === 1);
  assert.deepEqual(drags.map((r) => [r.properties.pip_drags_off_cursor, r.properties.pip_drags_slow_move, r.sent]), [[1, 0, false], [0, 1, false]]);
  const skips = await local("usage_counts", (p) => p.pip_click_skips_back === 1);
  assert.deepEqual(skips.map((r) => r.sent), [false]);
});

test("Picture in Picture resizes count the ones begun inside the window without the resize cursor, and an earlier consent period's stay local", async () => {
  pip.takePictureInPictureCounts();
  const stale = staleEpoch();
  pip.notePictureInPictureResized({ inside: true, cursorShown: false, epoch: stale });
  pip.notePictureInPictureResized({ inside: true, cursorShown: true, epoch: client.consentEpoch() });
  pip.notePictureInPictureResized({ inside: false, cursorShown: false, epoch: client.consentEpoch() });
  pip.notePictureInPictureResized({ inside: true, cursorShown: false, epoch: client.consentEpoch() });
  assert.deepEqual(pip.takePictureInPictureCounts().resizes, { started: 3, withoutCursor: 1 });
  const stalePrints = await local("usage_counts", (p) => p.pip_resizes === 1 && p.pip_resizes_without_cursor === 1);
  assert.deepEqual(stalePrints.map((r) => r.sent), [false]);
});

test("popup protected media reported in an earlier consent period, or with no epoch, isn't counted for this one and stays in the local copy", async () => {
  popup.takePopupProtectedMediaCounts();
  const stale = staleEpoch();
  popup.notePopupProtectedMedia({ family: "widevine", listed: true, epoch: stale });
  popup.notePopupProtectedMedia({ family: "none", listed: false });
  popup.notePopupProtectedMedia({ family: "playready", listed: false, epoch: client.consentEpoch() });
  const taken = popup.takePopupProtectedMediaCounts();
  assert.deepEqual([taken.popup_protected_media_refused_widevine_listed, taken.popup_protected_media_stalled_unlisted, taken.popup_protected_media_refused_playready_unlisted], [0, 0, 1]);
  const kept = await local("usage_counts", (p) => p.popup_protected_media_refused_widevine_listed === 1 || p.popup_protected_media_stalled_unlisted === 1);
  assert.deepEqual(kept.map((r) => r.sent), [false, false]);
});
