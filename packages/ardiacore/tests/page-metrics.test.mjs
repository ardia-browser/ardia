import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const source = readFileSync(new URL("../ios/page_metrics.js", import.meta.url), "utf8");

function page({ top = true, protocol = "https:" } = {}) {
  const listeners = new Map();
  const timers = [];
  const frames = [];
  const posts = [];
  let clock = 1000;
  let visibility = "visible";
  class EventTarget {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  }
  const videos = [];
  class Document extends EventTarget {
    getElementsByTagName() {
      return videos;
    }
  }
  Object.defineProperty(Document.prototype, "visibilityState", { get: () => visibility, configurable: true });
  class HTMLMediaElement {
    constructor(code) {
      this.error = { code };
    }
  }
  class Video extends HTMLMediaElement {
    constructor() {
      super(0);
      this.error = null;
      this.paused = true;
      this.ended = false;
      this.quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
    }
    getVideoPlaybackQuality() {
      return { ...this.quality };
    }
  }
  class Performance {
    now() {
      return clock;
    }
  }
  const document = new Document();
  const window = new EventTarget();
  window.requestAnimationFrame = (run) => frames.push(run);
  window.top = top ? window : {};
  const context = vm.createContext({
    window,
    document,
    location: { protocol },
    performance: new Performance(),
    Performance,
    EventTarget,
    Document,
    HTMLMediaElement,
    setInterval: () => 0,
    setTimeout: (run) => timers.push(run),
  });
  const receive = vm.runInContext(source, context)((kind, json) => posts.push({ kind, json }));
  return {
    receive,
    posts,
    context,
    video: () => {
      const v = new Video();
      videos.push(v);
      return v;
    },
    media: (type, target) => listeners.get(type)({ target }),
    mediaError: (code) => listeners.get("error")({ target: new HTMLMediaElement(code) }),
    pagehide: () => listeners.get("pagehide")(),
    hide: () => {
      visibility = "hidden";
      listeners.get("visibilitychange")();
    },
    scroll: (steps) => {
      for (let i = 0; i < steps; i++) {
        listeners.get("scroll")();
        clock += 8;
        frames.shift()?.();
      }
      clock += 500;
      while (frames.length) frames.shift()();
    },
    runTimers: () => {
      while (timers.length) timers.shift()();
    },
  };
}

const generation = (receive, value) => receive("metricsGeneration", JSON.stringify({ generation: value }));

test("nothing is collected or sent before native hands the page a generation", () => {
  const p = page();
  p.mediaError(4);
  p.scroll(10);
  p.pagehide();
  assert.deepEqual(p.posts, []);
});

test("a batch carries only the native generation and plain counts, never the consent epoch", () => {
  const p = page();
  generation(p.receive, 7);
  p.mediaError(4);
  p.mediaError(2);
  p.scroll(10);
  p.pagehide();
  assert.equal(p.posts.length, 1);
  const sent = JSON.parse(p.posts[0].json);
  assert.deepEqual(Object.keys(sent).sort(), ["dropped", "errors", "frames", "generation", "scrollFrames", "scrollMs", "scrolls"]);
  assert.equal(sent.generation, 7);
  assert.deepEqual(sent.errors, [0, 0, 1, 0, 1]);
  assert.equal(sent.scrolls, 1);
  assert.ok(sent.scrollFrames > 1 && sent.scrollMs > 0);
});

test("a page that poisons Object.prototype or JSON can't change what a batch says", () => {
  const p = page();
  vm.runInContext(
    `Object.prototype.toJSON = () => ({ epoch: "stolen" }); Object.defineProperty(Object.prototype, "generation", { get: () => 999, configurable: true }); JSON.stringify = () => '{"generation":999}';`,
    p.context,
  );
  generation(p.receive, 5);
  p.mediaError(3);
  p.pagehide();
  const sent = JSON.parse(p.posts[0].json);
  assert.equal(sent.generation, 5);
  assert.deepEqual(sent.errors, [0, 0, 0, 1, 0]);
  assert.ok(!p.posts[0].json.includes("stolen"));
});

test("a new generation drops the tally of the one before, and generation 0 stops collecting", () => {
  const p = page();
  generation(p.receive, 1);
  p.mediaError(4);
  generation(p.receive, 2);
  p.pagehide();
  assert.deepEqual(p.posts, []);
  p.mediaError(4);
  generation(p.receive, 0);
  p.mediaError(4);
  p.hide();
  assert.deepEqual(p.posts, []);
});

test("every hostile generation value leaves the page collecting nothing", () => {
  for (const { id, value } of HOSTILE_VALUES) {
    const p = page();
    p.receive("metricsGeneration", typeof value === "string" ? value : JSON.stringify({ generation: value }));
    p.receive("metricsGeneration", JSON.stringify({ generation: value }));
    p.mediaError(4);
    p.pagehide();
    assert.deepEqual(p.posts, [], id);
  }
  for (const value of [-1, 1.5e10, Number.MAX_SAFE_INTEGER, "7", null, true, [7], { generation: 7 }]) {
    const p = page();
    p.receive("metricsGeneration", JSON.stringify({ generation: value }));
    p.mediaError(4);
    p.pagehide();
    assert.deepEqual(p.posts, [], JSON.stringify(value));
  }
});

test("a media error code the page made up lands in the other slot", () => {
  const p = page();
  generation(p.receive, 9);
  for (const code of [0, 5, -1, 2.5, "4", null, Infinity]) p.mediaError(code);
  p.pagehide();
  const sent = JSON.parse(p.posts[0].json);
  assert.deepEqual(sent.errors.slice(1), [0, 1, 0, 0]);
  assert.equal(sent.errors[0], 6);
});

test("a child frame or a non-web page never installs the counters", () => {
  const child = vm.runInContext(source, vm.createContext({ location: { protocol: "https:" }, window: { top: {} } }))(() => {});
  assert.equal(child, undefined);
  const local = vm.runInContext(source, vm.createContext({ location: { protocol: "chrome:" }, window: {} }))(() => {});
  assert.equal(local, undefined);
});

test("the native guard drops child-frame batches and stale generations", () => {
  const mm = readFileSync(new URL("../ios/ArdiaWebView+PageMetrics.mm", import.meta.url), "utf8");
  const messages = readFileSync(new URL("../ios/ArdiaWebView+PageMessages.mm", import.meta.url), "utf8");
  assert.match(messages, /\[self notePageMetrics:dict main:main\]/);
  assert.match(mm, /ardia_page_metrics::Accept\(main, CurrentGenerationLocked\(\), batch\)/);
  assert.doesNotMatch(mm, /@"epoch"/);
});

test("a short video's frames are counted from when it starts playing to when it ends", () => {
  const p = page();
  generation(p.receive, 3);
  const v = p.video();
  v.paused = false;
  p.media("playing", v);
  v.quality = { totalVideoFrames: 450, droppedVideoFrames: 9 };
  v.paused = true;
  v.ended = true;
  p.media("ended", v);
  p.pagehide();
  const sent = JSON.parse(p.posts[0].json);
  assert.equal(sent.frames, 450);
  assert.equal(sent.dropped, 9);
});

test("frames a video played before the generation began are never counted", () => {
  const p = page();
  const v = p.video();
  v.paused = false;
  v.quality = { totalVideoFrames: 1000, droppedVideoFrames: 50 };
  p.media("playing", v);
  generation(p.receive, 4);
  v.quality = { totalVideoFrames: 1300, droppedVideoFrames: 51 };
  v.paused = true;
  p.media("pause", v);
  p.pagehide();
  assert.equal(p.posts.length, 1);
  const first = JSON.parse(p.posts.shift().json);
  assert.equal(first.frames, 300, "the frames after consent count, the 1000 before it don't");
  assert.equal(first.dropped, 1);
  v.paused = false;
  p.media("playing", v);
  v.quality = { totalVideoFrames: 1600, droppedVideoFrames: 53 };
  p.pagehide();
  const sent = JSON.parse(p.posts[0].json);
  assert.equal(sent.frames, 300);
  assert.equal(sent.dropped, 2);
});

test("a video past a million frames keeps counting its new frames, across a new generation too", () => {
  const p = page();
  generation(p.receive, 5);
  const v = p.video();
  v.paused = false;
  v.quality = { totalVideoFrames: 999_000, droppedVideoFrames: 10 };
  p.media("playing", v);
  v.quality = { totalVideoFrames: 1_200_000, droppedVideoFrames: 30 };
  p.pagehide();
  const first = JSON.parse(p.posts.shift().json);
  assert.equal(first.frames, 201_000);
  assert.equal(first.dropped, 20);
  v.quality = { totalVideoFrames: 1_500_000, droppedVideoFrames: 35 };
  p.pagehide();
  const second = JSON.parse(p.posts.shift().json);
  assert.equal(second.frames, 300_000, "a baseline past the cap still yields the real delta");
  assert.equal(second.dropped, 5);
  generation(p.receive, 6);
  v.quality = { totalVideoFrames: 1_800_000, droppedVideoFrames: 36 };
  p.pagehide();
  const third = JSON.parse(p.posts.shift().json);
  assert.equal(third.generation, 6);
  assert.equal(third.frames, 300_000, "the new generation's baseline is the real cumulative count, not the cap");
  assert.equal(third.dropped, 1);
  v.quality = { totalVideoFrames: 4_000_000, droppedVideoFrames: 40 };
  p.pagehide();
  const fourth = JSON.parse(p.posts.shift().json);
  assert.equal(fourth.frames, 1_000_000, "one message still caps the delta it reports");
  assert.equal(fourth.dropped, 4);
});
