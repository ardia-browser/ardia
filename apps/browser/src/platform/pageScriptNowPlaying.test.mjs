import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const define = (name, pattern, uses = {}) => {
  const source = script.match(pattern)?.[1];
  assert.ok(source, `page_script.js defines ${name}`);
  return new Function(...Object.keys(uses), `return ${source}`)(...Object.values(uses));
};
const clockPosition = define("clockPosition", /const clockPosition = (\(rate, clock, now\) => \{[\s\S]*?\n {2}\});\n/);
const timelineNow = define("timelineNow", /const timelineNow = (\(reported, mediaAdvance, now\) => \{[\s\S]*?\n {2}\});\n/, { clockPosition });
const oneShot = define("oneShot", /const oneShot = (\(m\) => .*);\n/);
const incidentalSound = define("incidentalSound", /const incidentalSound = (\(m, timeline\) => .*);\n/, { oneShot });
const mediaAdvanceOf = define("mediaAdvanceOf", /const mediaAdvanceOf = (\(el, timeline\) => .*);\n/, { incidentalSound });
const anchorStartedMedia = define("anchorStartedMedia", /const anchorStartedMedia = (\(timeline, m, followed, now\) => \{[\s\S]*?\n {2}\});\n/, { incidentalSound, timelineNow, mediaAdvanceOf });
const timelineReport = define("timelineReport", /const timelineReport = (\(timeline, el, now\) => \{[\s\S]*?\n {2}\});\n/, { mediaAdvanceOf, timelineNow });

const video = (currentTime, playbackRate = 1) => ({ currentTime, playbackRate });
const setAt = (position, { playing = true, playbackRate = 1, media = [] } = {}) => ({
  position,
  duration: 200,
  playbackRate,
  clock: { position, at: 0, advancing: playing },
  mediaTimes: new WeakMap(media.map(([el, at]) => [el, at])),
});

test("a site that set its position once is reported where it has played to since, not where it set it", () => {
  const el = video(110);
  assert.deepEqual(timelineReport(setAt(30, { media: [[el, 100]] }), el, 10_000), { position: 40, playbackRate: 1 });
  assert.deepEqual(timelineReport(setAt(30), null, 10_000), { position: 40, playbackRate: 1 }, "with no element to follow, its clock moves on");
});

test("a site's position stands still while it says it is paused", () => {
  assert.equal(timelineReport(setAt(30, { playing: false }), null, 10_000).position, 30);
});

test("the reported rate is the one the position moves at, so the card counts at the same speed", () => {
  const fast = video(110, 2);
  assert.deepEqual(timelineReport(setAt(30, { media: [[fast, 100]] }), fast, 5_000), { position: 40, playbackRate: 2 }, "following the element, its rate");
  assert.deepEqual(timelineReport(setAt(30, { playbackRate: 1.5 }), video(0, 2), 10_000), { position: 45, playbackRate: 1.5 }, "following the clock, the site's rate");
});

test("a site's position never runs past its duration or below zero", () => {
  assert.equal(timelineReport(setAt(195), null, 60_000).position, 200);
  const el = video(0);
  assert.equal(timelineReport(setAt(3, { media: [[el, 10]] }), el, 0).position, 0);
});

test("media that starts playing after the site set its position counts from where it starts, not from the site's clock", () => {
  const timeline = setAt(0);
  const audio = video(0);
  assert.equal(timelineReport(timeline, audio, 20_000).position, 20, "unseen, it follows the clock that ran while nothing played");
  timeline.started = false;
  timeline.clock = { position: 20, at: 20_000, advancing: true };
  assert.equal(anchorStartedMedia(timeline, audio, null, 20_000), 0, "even after the site said it plays, before anything did");
  assert.equal(timelineReport(timeline, audio, 20_000).position, 0);
  audio.currentTime = 5;
  assert.equal(timelineReport(timeline, audio, 25_000).position, 5);
});

test("media that starts while the site's position is already playing picks up where its clock is, and media already followed isn't moved", () => {
  const next = video(0);
  const timeline = setAt(30);
  timeline.started = true;
  assert.equal(anchorStartedMedia(timeline, next, null, 10_000), 40);
  next.currentTime = 2;
  assert.equal(timelineReport(timeline, next, 12_000).position, 42);
  assert.equal(anchorStartedMedia(timeline, next, null, 20_000), null);
});

test("media that takes over from the element the card followed picks up where that element got to, not the site's clock", () => {
  const fast = video(100, 2);
  const timeline = setAt(30, { media: [[fast, 100]] });
  timeline.started = true;
  fast.currentTime = 120;
  const next = video(0);
  assert.equal(anchorStartedMedia(timeline, next, fast, 10_000), 50, "the site never said 2x, so its clock is only at 40");
  next.currentTime = 1;
  assert.equal(timelineReport(timeline, next, 11_000).position, 51);
});

test("a preloaded track the site's position was set over still takes over from where the playing one got to", () => {
  const first = video(0), next = video(0);
  const timeline = setAt(30, { media: [[first, 0], [next, 0]] });
  assert.equal(anchorStartedMedia(timeline, first, null, 0), null, "the first one keeps the anchor it was set with");
  first.currentTime = 20;
  assert.equal(anchorStartedMedia(timeline, next, first, 20_000), 50);
  next.currentTime = 1;
  assert.equal(timelineReport(timeline, next, 21_000).position, 51);
  assert.equal(anchorStartedMedia(timeline, next, next, 30_000), null, "resuming the one it follows moves nothing");
});

test("a short sound the page plays meanwhile stays off the site's timeline, so it moves nothing", () => {
  const main = video(50), ding = { ...video(0), duration: 2.5 };
  const timeline = setAt(50, { playing: false, media: [[main, 50], [ding, 0]] });
  assert.equal(anchorStartedMedia(timeline, ding, main, 0), null);
  ding.currentTime = 2.5;
  assert.equal(timelineReport(timeline, ding, 2_500).position, 50, "reported while it plays, the paused site stays put");
  assert.equal(anchorStartedMedia(timeline, main, ding, 2_500), null, "the main player resumes on its own anchor");
  assert.equal(timelineReport(timeline, main, 2_500).position, 50);
});

test("a short clip that is the site's own media stays on its timeline", () => {
  const clip = { ...video(0), duration: 4 };
  const timeline = { ...setAt(0, { playing: false, media: [[clip, 0]] }), duration: 4 };
  clip.currentTime = 3;
  assert.equal(timelineReport(timeline, clip, 0).position, 3, "a seek in the clip moves the card");
});

test("page_script.js tracks setMicrophoneActive/setCameraActive with ordering guards and dispatches toggleMicrophone/toggleCamera", async () => {
  const { runInNewContext } = await import("node:vm");
  const start = script.indexOf("  const asNative = ");
  const end = script.indexOf("  const { keys, setPrototypeOf } = Object;\n", start);
  assert.ok(start > 0 && end > start, "page_script.js defines asNative");
  const blockStart = script.indexOf("  const session = navigator.mediaSession;");
  const blockEnd = script.indexOf("  const fieldProviderKit = (env) => {", blockStart);
  assert.ok(blockStart > 0 && blockEnd > blockStart, "page_script.js defines media session block");

  const reports = [];
  const timers = [];
  const docListeners = new Map();
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const pendingMic = [];
  const pendingCam = [];
  class MediaSessionProto {
    constructor() {
      this.metadata = null;
      this.playbackState = "none";
    }
    setActionHandler() {}
    setPositionState() {}
    setMicrophoneActive() {
      const d = deferred();
      pendingMic.push(d);
      return d.promise;
    }
    setCameraActive() {
      const d = deferred();
      pendingCam.push(d);
      return d.promise;
    }
  }
  const session = new MediaSessionProto();
  class MediaStream {
    constructor(audioTracks = []) {
      this._audio = audioTracks;
    }
    getAudioTracks() {
      return this._audio;
    }
  }
  class HTMLMediaElement {
    constructor() {
      this._paused = false;
      this.ended = false;
      this.muted = false;
      this.volume = 1;
      this.duration = Infinity;
      this.currentTime = 0;
      this.playbackRate = 1;
      this.tagName = "VIDEO";
      this.videoWidth = 640;
      this.loop = false;
      this.isConnected = true;
      this.srcObject = new MediaStream([{}]);
    }
    get paused() {
      return this._paused;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
    addEventListener() {}
  }
  class Node {
    get isConnected() {
      return true;
    }
  }
  const videoEl = new HTMLMediaElement();
  const ctx = {
    window: null,
    document: {
      title: "Meet - abc-defg-hij",
      pictureInPictureElement: null,
      querySelectorAll: (sel) => (sel === "video,audio" ? [videoEl] : []),
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
    },
    navigator: { mediaSession: session, userActivation: { isActive: true } },
    location: { href: "https://meet.google.com/abc-defg-hij" },
    performance: { now: () => 0 },
    URL,
    Promise,
    WeakSet,
    WeakMap,
    Map,
    Set,
    Reflect,
    Proxy,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    Date,
    TypeError,
    DOMException,
    MediaStream,
    HTMLMediaElement,
    Node,
    queueMicrotask,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    addEventListener() {},
  };
  ctx.window = ctx;
  const harness = `
    (function () {
      "use strict";
      const isTop = true;
      const frame = "f1";
      const tracked = new WeakSet();
      let active = null;
      let lastHeard = null;
      const heard = new WeakSet();
      const handlers = Object.create(null);
      const apply = Reflect.apply;
      ${script.slice(start, end)}
      const serialize = (v) => JSON.stringify(v);
      const send = (kind, data) => __reports.push({ kind, data });
      const guard = (fn) => function () { try { return apply(fn, this, arguments); } catch (e) {} };
      const later = (fn) => () => { setTimeout(() => guard(fn)(), 0); };
      ${script.slice(blockStart, blockEnd)}
      return { handlers, flush: () => { while (__timers.length) __timers.shift()(); } };
    })()
  `;
  ctx.__reports = reports;
  ctx.__timers = timers;
  const runtime = runInNewContext(harness, ctx);
  for (const fn of docListeners.get("playing") ?? []) fn({ type: "playing", target: videoEl });
  runtime.flush();

  const dispatched = [];
  session.setActionHandler("togglemicrophone", (d) => dispatched.push(d));
  session.setActionHandler("togglecamera", (d) => dispatched.push(d));
  session.setMicrophoneActive(false);
  session.setMicrophoneActive(true);
  pendingMic[1].resolve();
  await Promise.resolve();
  pendingMic[0].resolve();
  await Promise.resolve();
  runtime.flush();

  const latestAfterOrder = JSON.parse(JSON.stringify(reports.filter((r) => r.kind === "nowPlaying").at(-1)?.data));
  assert.deepEqual(latestAfterOrder.actions, ["togglemicrophone", "togglecamera"]);
  assert.equal(latestAfterOrder.microphoneActive, true, "stale earlier setMicrophoneActive promise must not overwrite newer state");
  assert.equal(latestAfterOrder.cameraActive, null);

  session.setCameraActive(true);
  session.setActionHandler("togglecamera", null);
  pendingCam[0].resolve();
  await Promise.resolve();
  runtime.flush();
  const latestAfterClear = JSON.parse(JSON.stringify(reports.filter((r) => r.kind === "nowPlaying").at(-1)?.data));
  assert.deepEqual(latestAfterClear.actions, ["togglemicrophone"]);
  assert.equal(latestAfterClear.cameraActive, null, "clearing togglecamera handler invalidates in-flight setCameraActive promise");

  session.setActionHandler("togglecamera", (d) => dispatched.push(d));
  runtime.handlers.media({ action: "toggleMicrophone", seconds: 0 });
  runtime.handlers.media({ action: "toggleCamera", seconds: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), [{ action: "togglemicrophone" }, { action: "togglecamera" }]);
});
