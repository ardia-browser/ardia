import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const source = script.match(/const pauseUnasked = (\(media, activated\) => \{[\s\S]*?\n {2}\});\n/)?.[1];
assert.ok(source, "page_script.js defines pauseUnasked");
const pauseUnasked = new Function(`return ${source}`)();
const playableSource = script.match(/const playableMedia = (\(all\) => .*);\n/)?.[1];
assert.ok(playableSource, "page_script.js defines playableMedia");
const playableMedia = new Function(`return ${playableSource}`)();

const judgeSource = script.match(/const judgeFrameActivation = (\(crossOrigin, isActive, now, schedule\) => \{[\s\S]*?\n {2}\});\n/)?.[1];
const judgeConstants = [...script.matchAll(/const (INHERITED_ACTIVATION_[A-Z_]+) = (\d+);\n/g)].map((m) => `const ${m[1]} = ${m[2]};`).join("\n");
assert.ok(judgeSource && judgeConstants.includes("INHERITED_ACTIVATION_WINDOW_MS"), "page_script.js defines judgeFrameActivation and its constants");
const judgeFrameActivation = new Function(`${judgeConstants}\nreturn ${judgeSource}`)();

function frame({ crossOrigin = true } = {}) {
  let clock = 0;
  let active = false;
  let timers = [];
  const judge = judgeFrameActivation(crossOrigin, () => active, () => clock, (fn, ms) => timers.push({ at: clock + ms, fn }));
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
  return { judge, advanceTo, setActive: (on) => (active = on), pending: () => timers.length };
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

test("a cross-origin frame that inherits nothing honours activation once its first second has passed", () => {
  const f = frame();
  f.advanceTo(2000);
  assert.equal(f.pending(), 0);
  assert.equal(f.judge(), false);
  f.setActive(true);
  assert.equal(f.judge(), true);
});

test("a frame on the top page's origin plays on a Play button in its parent at once", () => {
  const f = frame({ crossOrigin: false });
  f.setActive(true);
  assert.equal(f.judge(), true);
  assert.equal(f.pending(), 0);
});

const media = (playing) => ({ paused: !playing, pause() { this.paused = true; } });

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
