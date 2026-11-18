#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `Smoothness of the scroll-perf films, from the recorded frames: a frame is new when its crop of the gesture's region
(the scene's "done" event) differs from the frame before it.

  node apps/videos/scripts/fixes/scroll-perf-metrics.mjs <footage dir> <scene> [scene ...]

Per gesture and per scene, inside the stretch where the content moved (first to last new frame of the gesture):
  uniqueFps    new frames per second
  captureFps   frames the recorder took per second (the ceiling uniqueFps can reach)
  longestMs    the longest a frame stayed on screen (time between two new frames; 16.7 at 60 fps)
  hitches      runs of more than 2 repeated frames
  firstMs      gesture start to the first new frame
Each take also carries "changes" (1 per new frame, 0 per repeat, every frame) and "ptsMs" (each frame's time).
Names ending in -t<n> are takes of one scene: "summary" gives the median take's numbers per scene (and which take).
Prints JSON.`;

const argv = process.argv.slice(2);
if (argv.length < 2 || argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(argv.length < 2 ? 64 : 0);
}
const [dir, ...scenes] = argv;
const DOWN = 2;
const PIXEL = 14;
const SHARE = 0.0004;

function frames(mov, region, scale) {
  const [x, y, w, h] = region.map((v) => Math.round(v * scale));
  const cw = Math.floor(w / DOWN);
  const ch = Math.floor(h / DOWN);
  const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", mov], { encoding: "utf8" })
    .trim().split("\n").map(Number);
  const raw = join(tmpdir(), `scroll-perf-${process.pid}.gray`);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", mov, "-vf", `crop=${w}:${h}:${x}:${y},scale=${cw}:${ch}:flags=area,format=gray`, "-fps_mode", "passthrough", "-f", "rawvideo", raw]);
  const buf = readFileSync(raw);
  rmSync(raw, { force: true });
  const size = cw * ch;
  const n = Math.min(pts.length, Math.floor(buf.length / size));
  const changed = [false];
  const amount = [0];
  for (let i = 1; i < n; i++) {
    let count = 0;
    const a = (i - 1) * size;
    const b = i * size;
    for (let p = 0; p < size; p++) if (Math.abs(buf[a + p] - buf[b + p]) > PIXEL) count++;
    amount.push(count / size);
    changed.push(count > Math.max(6, size * SHARE));
  }
  return { pts: pts.slice(0, n), changed, amount };
}

const round = (v, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function gestureStats({ pts, changed }, start, end) {
  const idx = pts.map((t, i) => i).filter((i) => pts[i] >= start && pts[i] <= end + 0.15);
  const moved = idx.filter((i) => changed[i]);
  if (moved.length < 2) return { moved: moved.length, uniqueFps: null, captureFps: null, longestMs: null, hitches: 0, firstMs: moved.length ? round((pts[moved[0]] - start) * 1000) : null };
  const f0 = moved[0];
  const f1 = moved.at(-1);
  const span = pts[f1] - pts[f0];
  let longest = 0;
  let hitches = 0;
  let stillFrames = 0;
  for (let k = 1; k < moved.length; k++) {
    longest = Math.max(longest, pts[moved[k]] - pts[moved[k - 1]]);
    const repeated = moved[k] - moved[k - 1] - 1;
    stillFrames += repeated;
    if (repeated > 2) hitches++;
  }
  return {
    moved: moved.length,
    span: round(span * 1000, 0),
    uniqueFps: round((moved.length - 1) / span),
    captureFps: round((f1 - f0) / span),
    repeatedFrames: stillFrames,
    longestMs: round(longest * 1000),
    hitches,
    firstMs: round((pts[f0] - start) * 1000),
  };
}

const out = {};
for (const scene of scenes) {
  const meta = JSON.parse(readFileSync(join(dir, `${scene}.json`), "utf8"));
  const done = meta.events.find((e) => e.mark === "done");
  const f = frames(join(dir, `${scene}.mov`), done.region, meta.scale);
  const starts = meta.events.filter((e) => e.start);
  const gestures = starts.map((s) => {
    const e = meta.events.find((x) => x.end && x.mark === `${s.mark}-end`);
    return { gesture: s.gesture, at: s.t, ...gestureStats(f, s.t, e.t) };
  });
  const quietEnd = starts[0]?.t ?? 0;
  const quiet = f.amount.filter((_, i) => f.pts[i] < quietEnd);
  const ok = gestures.filter((g) => g.uniqueFps !== null);
  const totalMoved = ok.reduce((a, g) => a + g.moved - 1, 0);
  const totalSpan = ok.reduce((a, g) => a + g.span / 1000, 0);
  const totalCapture = ok.reduce((a, g) => a + g.captureFps * (g.span / 1000), 0);
  out[scene] = {
    frames: f.pts.length,
    noiseMax: round(Math.max(0, ...quiet) * 100, 3),
    uniqueFps: totalSpan ? round(totalMoved / totalSpan) : null,
    captureFps: totalSpan ? round(totalCapture / totalSpan) : null,
    longestMs: ok.length ? Math.max(...ok.map((g) => g.longestMs)) : null,
    hitches: ok.reduce((a, g) => a + g.hitches, 0),
    firstMs: ok.length ? round(ok.map((g) => g.firstMs).sort((a, b) => a - b)[ok.length >> 1]) : null,
    gestures,
    changes: f.changed.map((c) => (c ? 1 : 0)).join(""),
    ptsMs: f.pts.map((t) => Math.round(t * 1000)),
  };
}
const groups = {};
for (const name of Object.keys(out)) (groups[name.replace(/-t\d+$/, "")] ??= []).push(name);
const medianOf = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length ? s[(s.length - 1) >> 1] : null;
};
const summary = {};
for (const [scene, names] of Object.entries(groups)) {
  if (names.length < 2) continue;
  const takes = names.map((n) => out[n]);
  const fps = medianOf(takes.map((t) => t.uniqueFps));
  summary[scene] = {
    takes: names.length,
    uniqueFps: fps,
    longestMs: medianOf(takes.map((t) => t.longestMs)),
    hitches: medianOf(takes.map((t) => t.hitches)),
    firstMs: medianOf(takes.map((t) => t.firstMs)),
    captureFps: medianOf(takes.map((t) => t.captureFps)),
    range: { uniqueFps: [Math.min(...takes.map((t) => t.uniqueFps ?? Infinity)), Math.max(...takes.map((t) => t.uniqueFps ?? -Infinity))], longestMs: [Math.min(...takes.map((t) => t.longestMs ?? Infinity)), Math.max(...takes.map((t) => t.longestMs ?? -Infinity))] },
    medianTake: names[takes.findIndex((t) => t.uniqueFps === fps)] ?? names[0],
  };
}
console.log(JSON.stringify({ ...out, ...(Object.keys(summary).length ? { summary } : {}) }, null, 1));
