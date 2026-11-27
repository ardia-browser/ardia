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

const frameActivatedSource = script.match(/const frameActivated = (\(active, sinceStart\) => .*);\n/)?.[1];
const lifespan = script.match(/const INHERITED_ACTIVATION_MS = (\d+);\n/)?.[1];
assert.ok(frameActivatedSource && lifespan, "page_script.js defines frameActivated and INHERITED_ACTIVATION_MS");
const frameActivated = new Function(`const INHERITED_ACTIVATION_MS = ${lifespan}; return ${frameActivatedSource}`)();

test("an embedded player doesn't take the click that navigated its parent as a request to play (gong.bg's Vbox7, #3883)", () => {
  assert.equal(frameActivated(true, 0), false, "Chrome hands a new frame the navigating click's activation");
  assert.equal(frameActivated(true, 100), false);
  assert.equal(frameActivated(true, 4999), false);
  assert.equal(frameActivated(true, 5000), true, "past the 5 s activation lifespan the activation is a new one");
  assert.equal(frameActivated(false, 60000), false);
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
