#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { percentile, round1 } from "./stats.mjs";

const HELP = `Frame-difference metrics for one captured interaction, the same code for both sides.

  node scripts/mac/webui-bench/frames.mjs <spec.json>

spec.json: {"pattern": "dir/%05d.jpg" | "movie": "file.mov", "times": [ms per frame], "rest": ms (optional), "start": ms (optional),
            "inputs": [ms per input event] (optional), "crop": [x, y, w, h] in image pixels (optional)}
Frames are decoded to grey at half size. A frame is new when more than 0.04 % of its pixels differ by more than 14
levels from the frame before. Prints JSON: newFrames, slideMs, p50/p95/max of every interval between consecutive
new frames that overlaps the motion window [start, rest] (an interval that starts before rest and ends after it
counts whole, so a stall that outlasts the motion is never dropped; the wait from start to the first changed frame
counts when a captured frame sits at or before start, and pacingComplete is false when none does),
longGaps (> 25 ms), late120 (gaps over 1.5 frames at 120 Hz), rowsPaintedMs (rest to the last new frame after it),
blankFrames (every captured frame that is one flat colour, the first included), and with inputs, the latency from each input to the next new frame. Without a rest,
rest is the last new frame followed by at least 100 ms with no new frame; when the capture ends sooner, it is null.`;

export const PIXEL = 14;
export const SHARE = 0.0004;
export const QUIET_MS = 100;
export const DECODE_TIMEOUT_MS = 120000;
export const LONG_GAP_MS = 25;
export const INPUT_WINDOW_MS = 250;
export const BLANK_SPREAD = 6;

export function decode(spec, ffmpeg = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg") {
  const input = spec.movie ? ["-i", spec.movie] : ["-framerate", "1000", "-i", spec.pattern];
  const crop = spec.crop ? `crop=${spec.crop[2]}:${spec.crop[3]}:${spec.crop[0]}:${spec.crop[1]},` : "";
  const filter = `${crop}scale=trunc(iw/4)*2:trunc(ih/4)*2`;
  const run = (extra, maxBuffer) => execFileSync(ffmpeg, ["-v", "error", ...input, ...extra, "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer, timeout: DECODE_TIMEOUT_MS });
  return splitFrames(run(["-fps_mode", "passthrough"], 1 << 30), run(["-frames:v", "1"], 256 << 20).length);
}

export function splitFrames(raw, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`the first frame decoded to ${size} bytes`);
  if (!raw?.length) throw new Error("ffmpeg decoded no frames");
  if (raw.length % size) throw new Error(`decoded ${raw.length} bytes, not a whole number of ${size}-byte frames`);
  const frames = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  return frames;
}

export function differs(a, b) {
  if (a.length !== b.length) return true;
  const limit = SHARE * a.length;
  let count = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL && ++count > limit) return true;
  return false;
}

export function isBlank(frame) {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] < lo) lo = frame[i];
    if (frame[i] > hi) hi = frame[i];
    if (hi - lo > BLANK_SPREAD) return false;
  }
  return frame.length > 0;
}

export function freshFrames(frames, times) {
  const n = Math.min(frames.length, times.length);
  const fresh = [];
  for (let i = 1; i < n; i++) if (differs(frames[i - 1], frames[i])) fresh.push(i);
  return fresh;
}

export function gapsOf(times) {
  return times.slice(1).map((t, i) => t - times[i]);
}

export const FRAME_120_MS = 1000 / 120;
export const LATE_120_MS = FRAME_120_MS * 1.5;

export function windowGaps(fresh, start = -Infinity, end = Infinity, { coversStart = true } = {}) {
  const bounded = Number.isFinite(start);
  const inside = bounded ? fresh.filter((t) => t > start) : fresh;
  const points = bounded && coversStart ? [start, ...inside] : inside;
  const gaps = [];
  for (let i = 1; i < points.length; i++) if (points[i - 1] < end) gaps.push(points[i] - points[i - 1]);
  return gaps;
}

export function inputLatencies(freshTimes, inputs, windowMs = INPUT_WINDOW_MS) {
  return inputs.map((at, i) => {
    const next = inputs[i + 1] ?? Infinity;
    const hit = freshTimes.find((t) => t >= at && t < Math.min(next, at + windowMs));
    return hit === undefined ? null : round1(hit - at);
  });
}

export function restFromFrames(fresh, endAt, quietMs = QUIET_MS) {
  if (!fresh.length) return null;
  return endAt - fresh.at(-1) >= quietMs ? fresh.at(-1) : null;
}

export function analyze({ frames, times, rest, inputs, endAt, start = -Infinity }) {
  const n = Math.min(frames.length, times.length);
  const freshIdx = freshFrames(frames, times);
  const fresh = freshIdx.map((i) => times[i]);
  const end = rest ?? (endAt == null ? Infinity : restFromFrames(fresh, endAt) ?? Infinity);
  const slide = fresh.filter((t) => t <= end);
  const after = fresh.filter((t) => t > end);
  const coversStart = !Number.isFinite(start) || times.slice(0, n).some((t) => t <= start);
  const gaps = windowGaps(fresh, start, end, { coversStart });
  const result = {
    frames: Math.min(frames.length, times.length),
    newFrames: fresh.length,
    slideFrames: slide.length,
    slideMs: round1(slide.length > 1 ? slide.at(-1) - slide[0] : 0),
    p50GapMs: round1(percentile(gaps, 50)),
    p95GapMs: round1(percentile(gaps, 95)),
    maxGapMs: round1(gaps.length ? Math.max(...gaps) : null),
    longGaps: gaps.filter((g) => g > LONG_GAP_MS).length,
    late120: gaps.filter((g) => g > LATE_120_MS).length,
    pacingComplete: coversStart,
    rowsPaintedMs: round1(after.length && Number.isFinite(end) ? after.at(-1) - end : 0),
    blankFrames: frames.slice(0, n).filter(isBlank).length,
    firstFrameBlank: n ? isBlank(frames[0]) : null,
    restAt: Number.isFinite(end) ? round1(end) : null,
  };
  if (inputs) {
    const latencies = inputLatencies(fresh, inputs);
    result.inputLatenciesMs = latencies;
    result.missedInputs = latencies.filter((v) => v === null).length;
  }
  return { ...result, fresh };
}

export function settleMs(samples, { epsilon = 0.01, quietMs = QUIET_MS, quietSamples = 2 } = {}) {
  const moving = samples.map((s, i) => i > 0 && Math.abs(s[1] - samples[i - 1][1]) > epsilon);
  const first = moving.indexOf(true);
  if (first < 0) return { startAt: null, restAt: null, restMs: null, settled: false };
  const last = moving.lastIndexOf(true);
  const tail = samples.slice(last + 1);
  const settled = tail.length >= quietSamples && tail.at(-1)[0] - samples[last][0] >= quietMs;
  const startAt = samples[first][0];
  const restAt = settled ? samples[last][0] : null;
  return { startAt, restAt, restMs: settled ? round1(restAt - startAt) : null, settled };
}

export const measure = (spec) => analyze({ ...spec, frames: decode(spec) });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(arg ? 0 : 64);
  }
  const { fresh, ...metrics } = measure(JSON.parse(readFileSync(arg, "utf8")));
  console.log(JSON.stringify(metrics));
}
