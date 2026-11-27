import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const source = script.match(/const pauseUnasked = (\(media, activated\) => \{[\s\S]*?\n {2}\});\n/)?.[1];
assert.ok(source, "page_script.js defines pauseUnasked");
const nativePaused = function () {
  if (!(this instanceof Media)) throw new TypeError("Illegal invocation");
  return this.state === "paused";
};
const nativePause = function () {
  if (!(this instanceof Media)) throw new TypeError("Illegal invocation");
  this.state = "paused";
};
const pauseUnasked = new Function("pausedState", "pauseMedia", "apply", `return ${source}`)(nativePaused, nativePause, Reflect.apply);
const playableSource = script.match(/const playableMedia = (\(all\) => .*);\n/)?.[1];
assert.ok(playableSource, "page_script.js defines playableMedia");
const playableMedia = new Function(`return ${playableSource}`)();

const judgeSource = script.match(/const judgeFrameActivation = (\(guarded, isActive, inputInEmbed, now, embedStartedAt, schedule\) => \{[\s\S]*?\n {2}\});\n/)?.[1];
const judgeConstants = [...script.matchAll(/const (INHERITED_ACTIVATION_[A-Z_]+) = (\d+);\n/g)].map((m) => `const ${m[1]} = ${m[2]};`).join("\n");
assert.ok(judgeSource && judgeConstants.includes("INHERITED_ACTIVATION_SETTLED_MS"), "page_script.js defines judgeFrameActivation and its constants");
const judgeFrameActivation = new Function(`${judgeConstants}\nreturn ${judgeSource}`)();

function frame({ guarded = true, embedStartedAt = 0, startAt = embedStartedAt, pollDelay = (ms) => ms, activeAtStart = false } = {}) {
  let clock = startAt;
  let active = activeAtStart;
  let input = false;
  let timers = [];
  const judge = judgeFrameActivation(guarded, () => active, () => input, () => clock, embedStartedAt, (fn, ms) => timers.push({ at: clock + pollDelay(ms), fn }));
  const advanceTo = (t) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > t) break;
      timers = timers.slice(1);
      clock = next.at;
      next.fn();
    }
    clock = t;
  };
  return { judge, advanceTo, setActive: (on) => (active = on), setInput: (on) => (input = on), pending: () => timers.length };
}

test("a cross-origin player doesn't take the click that navigated its parent as a request to play, however late it ends (gong.bg's Vbox7, #3883)", () => {
  const f = frame();
  f.advanceTo(100);
  f.setActive(true);
  f.advanceTo(400);
  assert.equal(f.judge(), false, "Chrome hands the new frame the navigating click's activation");
  f.advanceTo(5050);
  assert.equal(f.judge(), false, "still the inherited activation past five seconds");
  f.setActive(false);
  f.advanceTo(5200);
  f.setActive(true);
  assert.equal(f.judge(), true, "once it has run out, a new activation counts");
  assert.equal(f.pending(), 0, "nothing keeps polling");
});

test("a late first timer never mistakes an inherited activation that is still on for a fresh one", () => {
  const f = frame({ pollDelay: () => 1200 });
  f.advanceTo(100);
  f.setActive(true);
  f.advanceTo(1200);
  assert.equal(f.judge(), false);
  f.advanceTo(4000);
  assert.equal(f.judge(), false);
});

test("an inherited activation a play() sees before the first poll is caught too", () => {
  const f = frame();
  f.setActive(true);
  assert.equal(f.judge(), false);
  f.advanceTo(6000);
  assert.equal(f.judge(), false);
  f.setActive(false);
  f.advanceTo(6100);
  f.setActive(true);
  assert.equal(f.judge(), true);
});

test("past the settled bound nothing inherited can still be on, so activation counts and polling stops", () => {
  const f = frame({ pollDelay: () => 100000 });
  f.setActive(true);
  f.advanceTo(7000);
  assert.equal(f.judge(), true);
});

test("a media frame that a same-origin controller frame starts on Play plays at once after a trusted input in that embed, and nothing else unlocks it", () => {
  const f = frame({ embedStartedAt: 0, startAt: 3000, activeAtStart: true });
  assert.equal(f.judge(), false, "an inherited activation with no input in the embed stays suspect, wherever focus is");
  f.setInput(true);
  assert.equal(f.judge(), true, "the user pressed something inside the embed");
});

test("a cross-origin frame that inherits nothing honours activation once its first second has passed", () => {
  const f = frame();
  f.advanceTo(2000);
  assert.equal(f.pending(), 0);
  assert.equal(f.judge(), false);
  f.setActive(true);
  assert.equal(f.judge(), true);
});

test("a frame in the top page's origin chain plays on a Play button in its parent at once", () => {
  const f = frame({ guarded: false });
  f.setActive(true);
  assert.equal(f.judge(), true);
  assert.equal(f.pending(), 0);
});

class Media {
  constructor(playing) {
    this.state = playing ? "playing" : "paused";
  }
  get paused() {
    return this.state === "paused";
  }
  pause() {
    this.state = "paused";
  }
}
const media = (playing) => new Media(playing);

test("media playing before the config came is paused", () => {
  const video = media(true), audio = media(true), idle = media(false);
  assert.equal(pauseUnasked([video, audio, idle], false), 2);
  assert.ok(video.paused && audio.paused && idle.paused);
});

test("the same element listed twice (the active one, then from the DOM) is paused once", () => {
  const video = media(true);
  assert.equal(pauseUnasked([video, video, null], false), 1);
  assert.ok(video.paused);
});

test("a page that overrides an element's paused and pause still has its unasked playback paused and counted once", () => {
  const video = media(true);
  let pageCalls = 0;
  Object.defineProperty(video, "paused", { get: () => true });
  video.pause = () => pageCalls++;
  assert.equal(pauseUnasked([video], false), 1);
  assert.equal(video.state, "paused");
  assert.equal(pageCalls, 0, "the page's own pause never ran");
  assert.equal(pauseUnasked([video, { paused: false, pause() {} }], false), 0, "already paused, and a stranger that isn't media is left alone");
});

test("one blocked attempt counts once: the config pauses it, then its queued play event finds it paused", () => {
  const video = media(true);
  const counted = pauseUnasked([video], false) + pauseUnasked([video], false);
  assert.equal(counted, 1);
  assert.ok(video.paused);
});

test("a page the user already used keeps playing: autoplay blocking is for media nobody asked for", () => {
  const video = media(true);
  assert.equal(pauseUnasked([video], true), 0);
  assert.equal(video.paused, false);
});

const element = ({ currentSrc = "", src = "", srcObject = null, source = false } = {}) => ({
  currentSrc,
  src,
  srcObject,
  querySelector: (selector) => (selector === "source[src]" && source ? {} : null),
});

test("a media command on a reloaded page reaches its paused <video> even with no MediaSession", () => {
  const empty = element();
  const video = element({ currentSrc: "https://site/clip.mp4" });
  assert.equal(playableMedia([empty, video]), video);
  const sourced = element({ source: true });
  assert.equal(playableMedia([empty, sourced]), sourced, "a <source> child counts before resource selection");
  const stream = element({ srcObject: {} });
  assert.equal(playableMedia([stream]), stream);
  assert.equal(playableMedia([empty]), null, "nothing to play: nothing is played");
});
