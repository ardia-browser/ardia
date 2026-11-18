import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const define = (name, pattern, uses = {}) => {
  const source = script.match(pattern)?.[1];
  assert.ok(source, `page_script.js defines ${name}`);
  return new Function(...Object.keys(uses), `return ${source}`)(...Object.values(uses));
};
const pictureInPictureMedia = define("pictureInPictureMedia", /const pictureInPictureMedia = (\(root\) => \{[\s\S]*?\n {2}\});\n/);
const mediaCommandTarget = define("mediaCommandTarget", /const mediaCommandTarget = (\(action, inPictureInPicture, pick\) => \{[\s\S]*?\n {2}\});\n/);
const clockPosition = define("clockPosition", /const clockPosition = (\(rate, clock, now\) => \{[\s\S]*?\n {2}\});\n/);
const timelineNow = define("timelineNow", /const timelineNow = (\(reported, mediaAdvance, now\) => \{[\s\S]*?\n {2}\});\n/, { clockPosition });
const seekByCall = define("seekByCall", /const seekByCall = (\(seconds, el, registered, timeline\) => \{[\s\S]*?\n {2}\});\n/);

const video = (currentTime) => ({ currentTime });
const page = (...names) => (name) => names.includes(name);

test("a Picture in Picture skip seeks the video in the window, not the one the page is playing", () => {
  const inWindow = video(60), playing = video(20);
  assert.deepEqual(mediaCommandTarget("seekPictureInPictureBy", inWindow, () => playing), { action: "seekBy", el: inWindow });
});

test("a frame with nothing in Picture in Picture ignores the skip, so only the window's frame seeks", () => {
  let picked = 0;
  assert.equal(mediaCommandTarget("seekPictureInPictureBy", null, () => (picked++, video(20))), null);
  assert.equal(picked, 0);
});

test("every other media command keeps the page's own pick, even with a video in Picture in Picture", () => {
  const inWindow = video(60), playing = video(20);
  for (const action of ["seekBy", "seekTo", "toggle", "pause"]) assert.deepEqual(mediaCommandTarget(action, inWindow, () => playing), { action, el: playing });
});

test("a video inside open shadow roots is found through its hosts", () => {
  const inWindow = video(60);
  const inner = { shadowRoot: { pictureInPictureElement: inWindow } };
  const outer = { shadowRoot: { pictureInPictureElement: inner } };
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: outer }), inWindow);
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: inWindow }), inWindow);
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: null }), null);
});

test("a closed shadow root hides the video: the skip seeks no element, neither the host nor another video the page plays", () => {
  const host = { shadowRoot: null };
  let picked = 0;
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: host }), host);
  assert.deepEqual(mediaCommandTarget("seekPictureInPictureBy", host, () => (picked++, video(20))), { action: "seekBy", el: null });
  assert.equal(picked, 0);
});

test("a skip goes to the page's relative seek handler for its direction when it has one", () => {
  assert.deepEqual(seekByCall(10, video(60), page("seekforward", "seekbackward", "seekto")), ["seekforward", { seekOffset: 10 }]);
  assert.deepEqual(seekByCall(-10, video(60), page("seekforward", "seekbackward", "seekto")), ["seekbackward", { seekOffset: 10 }]);
  assert.deepEqual(seekByCall(10, null, page("seekforward")), ["seekforward", { seekOffset: 10 }]);
});

test("a page with only a seekto handler is asked to seek to the new time instead of having currentTime set behind its back", () => {
  assert.deepEqual(seekByCall(10, video(60), page("seekto")), ["seekto", { seekTime: 70 }]);
  assert.deepEqual(seekByCall(-10, video(60), page("seekto", "seekforward")), ["seekto", { seekTime: 50 }]);
});

test("with no handler the element is seeked, kept inside the media", () => {
  assert.deepEqual(seekByCall(10, video(60), page()), ["currentTime", { seekTime: 70 }]);
  assert.deepEqual(seekByCall(-10, video(4), page()), ["currentTime", { seekTime: 0 }]);
  assert.deepEqual(seekByCall(10, { currentTime: 175, duration: 180 }, page()), ["currentTime", { seekTime: 180 }]);
});

test("with no element, no relative handler and no reported position nothing is seeked: the current time is unknown, so seekto gets no guess", () => {
  assert.equal(seekByCall(10, null, page("seekto")), null);
  assert.equal(seekByCall(10, null, page("seekto"), null), null);
  assert.equal(seekByCall(-10, null, page("seekforward")), null);
});

test("a page that reports its own timeline gets seekto on that timeline, not the element's", () => {
  const timeline = { position: 620, duration: 3600 };
  assert.deepEqual(seekByCall(10, video(20), page("seekto"), timeline), ["seekto", { seekTime: 630 }]);
  assert.deepEqual(seekByCall(-10, video(20), page("seekto"), timeline), ["seekto", { seekTime: 610 }]);
  assert.deepEqual(seekByCall(10, video(20), page("seekto"), { position: 3595, duration: 3600 }), ["seekto", { seekTime: 3600 }]);
  assert.deepEqual(seekByCall(-10, video(20), page("seekto"), { position: 4, duration: 3600 }), ["seekto", { seekTime: 0 }]);
  assert.deepEqual(seekByCall(10, video(20), page("seekto"), { position: 620, duration: Infinity }), ["seekto", { seekTime: 630 }]);
});

test("the reported timeline reaches a video the page hides in a closed shadow root", () => {
  assert.deepEqual(seekByCall(10, null, page("seekto"), { position: 620, duration: 3600 }), ["seekto", { seekTime: 630 }]);
});

test("the reported timeline is the page's handlers' only: with no handler the element is seeked on its own time", () => {
  assert.deepEqual(seekByCall(10, video(20), page(), { position: 620, duration: 3600 }), ["currentTime", { seekTime: 30 }]);
  assert.deepEqual(seekByCall(10, video(20), page("seekforward"), { position: 620, duration: 3600 }), ["seekforward", { seekOffset: 10 }]);
});

const reported = (clock, more = {}) => ({ position: 620, duration: 3600, playbackRate: 1, clock: { position: 620, at: 1000, advancing: true, ...clock }, ...more });

test("the reported position follows the media it was reported beside: what that media played, paused or sought since", () => {
  assert.deepEqual(timelineNow(reported(), 0, 1000), { position: 620, duration: 3600 });
  assert.deepEqual(timelineNow(reported(), 20, 60000), { position: 640, duration: 3600 });
  assert.deepEqual(timelineNow(reported(), 10, 1040), { position: 630, duration: 3600 });
  assert.deepEqual(timelineNow(reported(), -30, 5000), { position: 590, duration: 3600 });
});

test("a second skip right after the first starts from where the first one put the media", () => {
  const first = seekByCall(10, video(20), page("seekto"), timelineNow(reported(), 0, 1000));
  assert.deepEqual(first, ["seekto", { seekTime: 630 }]);
  assert.deepEqual(seekByCall(10, video(30), page("seekto"), timelineNow(reported(), 10, 1040)), ["seekto", { seekTime: 640 }]);
});

test("a pause keeps the time played before it: 20 s played after a report at 620, then paused, skips to 650", () => {
  assert.deepEqual(seekByCall(10, video(40), page("seekto"), timelineNow(reported(), 20, 90000)), ["seekto", { seekTime: 650 }]);
});

test("with no media in reach the position runs on the clock from its last restart, at the reported rate, and holds while paused", () => {
  assert.deepEqual(timelineNow(reported(), null, 2500), { position: 621.5, duration: 3600 });
  assert.deepEqual(timelineNow(reported({}, { playbackRate: 2 }), null, 2500), { position: 623, duration: 3600 });
  assert.deepEqual(timelineNow(reported({ advancing: false }), null, 90000), { position: 620, duration: 3600 });
  assert.deepEqual(timelineNow(reported({ position: 640, at: 21000, advancing: false }), null, 90000), { position: 640, duration: 3600 });
  assert.deepEqual(timelineNow(reported({ position: 630, at: 1040 }), null, 1080), { position: 630.04, duration: 3600 });
});

test("the position stays inside the reported duration", () => {
  assert.deepEqual(timelineNow(reported(), 5000, 1000), { position: 3600, duration: 3600 });
  assert.deepEqual(timelineNow(reported(), -5000, 1000), { position: 0, duration: 3600 });
  assert.deepEqual(timelineNow(reported({}, { playbackRate: -2 }), null, 900000), { position: 0, duration: 3600 });
  assert.deepEqual(timelineNow(reported({}, { duration: Infinity }), null, 2000), { position: 621, duration: Infinity });
});
