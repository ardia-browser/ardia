(function (post) {
  "use strict";
  if (!/^(https?|file):$/.test(location.protocol) || window !== window.top) return;
  const apply = Reflect.apply;
  const create = Object.create;
  const { floor, min, round } = Math;
  const isFiniteNumber = Number.isFinite;
  const raf = window.requestAnimationFrame;
  const perfNow = Performance.prototype.now;
  const now = () => apply(perfNow, performance, []);
  const every = setInterval;
  const after = setTimeout;
  const listen = EventTarget.prototype.addEventListener;
  const byTag = Document.prototype.getElementsByTagName;
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get;
  const MediaElement = HTMLMediaElement;
  const fromJSON = JSON.parse;
  const FLUSH_MS = 60000;
  const SAMPLE_MS = 10000;
  const SCROLL_IDLE_MS = 150;
  const SOON_MS = 5000;
  const MOST = 1000000;
  const MAX_GENERATION = 2147483647;
  const cumulative = (value) => (typeof value === "number" && isFiniteNumber(value) && value >= 0 ? floor(value) : 0);
  const fresh = () => {
    const t = create(null);
    t.e0 = 0;
    t.e1 = 0;
    t.e2 = 0;
    t.e3 = 0;
    t.e4 = 0;
    t.dropped = 0;
    t.frames = 0;
    t.scrolls = 0;
    t.scrollFrames = 0;
    t.scrollMs = 0;
    return t;
  };
  let generation = 0;
  let tally = fresh();
  let quality = new WeakMap();
  let burst = null;
  let flushing = false;
  const handlers = create(null);
  const visible = () => apply(visibility, document, []) === "visible";

  const encode = (t) =>
    `{"generation":${generation},"errors":[${t.e0},${t.e1},${t.e2},${t.e3},${t.e4}],"dropped":${t.dropped},"frames":${t.frames},"scrolls":${t.scrolls},"scrollFrames":${t.scrollFrames},"scrollMs":${t.scrollMs}}`;

  const flush = () => {
    flushing = false;
    if (burst) endBurst(burst);
    sampleVideos();
    const t = tally;
    tally = fresh();
    if (!generation || !(t.e0 || t.e1 || t.e2 || t.e3 || t.e4 || t.frames || t.scrolls)) return;
    try {
      post("pageMetrics", encode(t));
    } catch (e) {}
  };

  handlers.metricsGeneration = (message) => {
    const value = message && typeof message === "object" ? message.generation : 0;
    const next = typeof value === "number" && isFiniteNumber(value) && value >= 0 && value <= MAX_GENERATION ? floor(value) : 0;
    if (next === generation) return;
    generation = next;
    tally = fresh();
    quality = new WeakMap();
    burst = null;
    if (!generation) return;
    const videos = apply(byTag, document, ["video"]);
    for (let i = 0; i < videos.length; i++) if (!videos[i].paused && !videos[i].ended) collect(videos[i], false);
  };

  const soon = () => {
    if (flushing || !generation) return;
    flushing = true;
    after(flush, SOON_MS);
  };

  apply(listen, document, [
    "error",
    (e) => {
      const target = e.target;
      if (!generation || !(target instanceof MediaElement) || !target.error) return;
      const code = target.error.code;
      const slot = typeof code === "number" && code >= 1 && code <= 4 ? floor(code) : 0;
      tally["e" + slot] = min(MOST, tally["e" + slot] + 1);
      soon();
    },
    { capture: true, passive: true },
  ]);

  const collect = (video, stopped) => {
    if (!generation || typeof video.getVideoPlaybackQuality !== "function") return;
    const q = video.getVideoPlaybackQuality();
    const seen = { dropped: cumulative(q && q.droppedVideoFrames), total: cumulative(q && q.totalVideoFrames) };
    const before = quality.get(video);
    if (stopped) quality.delete(video);
    else quality.set(video, seen);
    if (!before) return;
    const total = seen.total - before.total;
    const dropped = seen.dropped - before.dropped;
    if (total > 0 && dropped >= 0 && dropped <= total) {
      tally.frames = min(MOST, tally.frames + total);
      tally.dropped = min(MOST, tally.dropped + dropped);
      soon();
    }
  };

  const sampleVideos = () => {
    if (!generation) return;
    const videos = apply(byTag, document, ["video"]);
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const stopped = video.paused || video.ended;
      if (stopped ? quality.has(video) : visible()) collect(video, stopped);
    }
  };

  const videoStopped = (e) => {
    const target = e.target;
    if (generation && target instanceof MediaElement && quality.has(target)) collect(target, true);
  };

  const endBurst = (b) => {
    if (burst === b) burst = null;
    const ms = round(b.frameAt - b.start);
    if (b.frames < 2 || ms <= 0) return;
    tally.scrolls = min(MOST, tally.scrolls + 1);
    tally.scrollFrames = min(MOST, tally.scrollFrames + b.frames);
    tally.scrollMs = min(MOST, tally.scrollMs + ms);
    soon();
  };

  const countFrames = (b) => {
    const step = () => {
      if (burst !== b) return;
      const at = now();
      if (at - b.last > SCROLL_IDLE_MS) return endBurst(b);
      b.frames++;
      b.frameAt = at;
      apply(raf, window, [step]);
    };
    apply(raf, window, [step]);
  };

  apply(listen, window, [
    "scroll",
    () => {
      if (!generation) return;
      const at = now();
      if (burst && at - burst.last <= SCROLL_IDLE_MS) {
        burst.last = at;
        return;
      }
      if (burst) endBurst(burst);
      burst = { start: at, last: at, frameAt: at, frames: 0 };
      countFrames(burst);
    },
    { capture: true, passive: true },
  ]);

  apply(listen, document, [
    "playing",
    (e) => {
      const target = e.target;
      if (generation && target instanceof MediaElement) collect(target, false);
    },
    { capture: true, passive: true },
  ]);
  apply(listen, document, ["pause", videoStopped, { capture: true, passive: true }]);
  apply(listen, document, ["ended", videoStopped, { capture: true, passive: true }]);
  apply(listen, document, [
    "visibilitychange",
    () => {
      if (!visible()) flush();
    },
  ]);
  apply(listen, window, ["pagehide", flush]);
  every(sampleVideos, SAMPLE_MS);
  every(flush, FLUSH_MS);

  return (kind, json) => {
    const handler = handlers[kind];
    if (!handler) return;
    try {
      handler(fromJSON(json));
    } catch (e) {}
  };
})
