import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const client = await import("./client.ts");
const { notePopupProtectedMedia, takePopupProtectedMediaCounts } = await import("./popupProtectedMedia.ts");
after(() => client.setSharing(false, "settings"));

const zero = {
  popup_protected_media_refused_widevine_listed: 0,
  popup_protected_media_refused_widevine_unlisted: 0,
  popup_protected_media_refused_playready_listed: 0,
  popup_protected_media_refused_playready_unlisted: 0,
  popup_protected_media_refused_fairplay_listed: 0,
  popup_protected_media_refused_fairplay_unlisted: 0,
  popup_protected_media_refused_other_listed: 0,
  popup_protected_media_refused_other_unlisted: 0,
  popup_protected_media_stalled_listed: 0,
  popup_protected_media_stalled_unlisted: 0,
};

test("nothing counted until a popup reports protected media", () => {
  client.setSharing(true, "onboarding");
  assert.deepEqual(takePopupProtectedMediaCounts(), zero);
});

test("each refusal counts once under its key-system family and whether the popup's host is listed, a stall counts apart, and a take resets", () => {
  client.setSharing(true, "onboarding");
  notePopupProtectedMedia({ family: "widevine", listed: false });
  notePopupProtectedMedia({ family: "widevine", listed: false });
  notePopupProtectedMedia({ family: "widevine", listed: true });
  notePopupProtectedMedia({ family: "playready", listed: false });
  notePopupProtectedMedia({ family: "fairplay", listed: true });
  notePopupProtectedMedia({ family: "none", listed: false });
  assert.deepEqual(takePopupProtectedMediaCounts(), {
    ...zero,
    popup_protected_media_refused_widevine_listed: 1,
    popup_protected_media_refused_widevine_unlisted: 2,
    popup_protected_media_refused_playready_unlisted: 1,
    popup_protected_media_refused_fairplay_listed: 1,
    popup_protected_media_stalled_unlisted: 1,
  });
  assert.deepEqual(takePopupProtectedMediaCounts(), zero);
});

test("a family or flag the app doesn't know counts as other and unlisted, never as a new field", () => {
  client.setSharing(true, "onboarding");
  notePopupProtectedMedia({ family: "clearkey", listed: "yes" });
  notePopupProtectedMedia({ family: "https://audible.com/webplayer" });
  notePopupProtectedMedia(undefined);
  const counts = takePopupProtectedMediaCounts();
  assert.deepEqual(counts, { ...zero, popup_protected_media_refused_other_unlisted: 3 });
  assert.deepEqual(Object.keys(counts), Object.keys(zero));
});

test("nothing is counted while sharing is off, and a pending count is dropped when sharing changes", () => {
  client.setSharing(false, "settings");
  notePopupProtectedMedia({ family: "widevine", listed: false });
  client.setSharing(true, "onboarding");
  assert.deepEqual(takePopupProtectedMediaCounts(), zero);
  notePopupProtectedMedia({ family: "widevine", listed: false });
  client.setSharing(false, "settings");
  client.setSharing(true, "onboarding");
  assert.deepEqual(takePopupProtectedMediaCounts(), zero);
});
