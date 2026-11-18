#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Builds the scroll-perf film's footage and timeline from film-scroll-perf.sh runs: picks each scene's median take,
converts it to constant 60 fps (a repeated frame stays repeated), and writes src/videos/scroll-perf/timeline.json.

  node apps/videos/scripts/fixes/scroll-perf-film.mjs --before <metrics.json>[,<metrics.json>] [--after <metrics.json>[,…]]
       [--footage <scratch>/footage] [--before-label TEXT] [--after-label TEXT] [--kind pan|trackpad]

Without --after the after panels are placeholders. Render with: pnpm -C apps/videos render scroll-perf`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || !argv.includes("--before")) {
  console.log(HELP);
  process.exit(argv.includes("--before") ? 0 : 64);
}
const flag = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const here = dirname(fileURLToPath(import.meta.url));
const videos = join(here, "../..");
const footage = flag("footage", "/tmp/ardia-perf/film/footage");
const FPS = 60;
const SCENES = ["scrollperf-strip", "scrollperf-swipe", "scrollperf-sidebar"];

function load(list) {
  const out = {};
  const summary = {};
  for (const file of list.split(",")) {
    const one = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(summary, one.summary ?? {});
    Object.assign(out, one);
  }
  out.summary = summary;
  return out;
}

function pick(metrics, scene) {
  const summary = Object.entries(metrics.summary ?? {}).find(([k]) => k.startsWith(`${scene}-`))?.[1];
  const takes = Object.keys(metrics).filter((k) => k.startsWith(`${scene}-`) && /-t\d+$/.test(k));
  const name = summary?.medianTake ?? takes[0];
  if (!name) return null;
  return { name, take: metrics[name], summary: summary ?? null, takes: takes.map((k) => ({ name: k, uniqueFps: metrics[k].uniqueFps, longestMs: metrics[k].longestMs, hitches: metrics[k].hitches })) };
}

function side(metrics, label, dirName) {
  if (!metrics) return null;
  const scenes = {};
  for (const scene of SCENES) {
    const got = pick(metrics, scene);
    if (!got) continue;
    const meta = JSON.parse(readFileSync(join(footage, dirName, `${got.name}.json`), "utf8"));
    const starts = meta.events.filter((e) => e.start);
    const ends = meta.events.filter((e) => e.end);
    const inS = Math.max(0, starts[0].t - 0.5);
    const outS = ends.at(-1).t + 0.6;
    const file = `footage/scroll-perf/${dirName}/${scene}.mp4`;
    const dest = join(videos, "public", file);
    mkdirSync(dirname(dest), { recursive: true });
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", join(footage, dirName, `${got.name}.mov`), "-vf", `fps=${FPS}`, "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dest]);
    const { changes, ptsMs } = got.take;
    const flags = [];
    for (let i = 0, t = inS; t <= outS; i++, t = inS + i / FPS) {
      const lo = (t - 1 / FPS) * 1000;
      const hi = t * 1000;
      let changed = 0;
      for (let k = 0; k < ptsMs.length; k++) if (ptsMs[k] > lo && ptsMs[k] <= hi && changes[k] === "1") changed = 1;
      flags.push(changed);
    }
    const { gestures, changes: _c, ptsMs: _p, ...numbers } = got.take;
    scenes[scene] = {
      file,
      take: got.name,
      w: meta.rect[2],
      h: meta.rect[3],
      scale: meta.scale,
      inS: Math.round(inS * 1000) / 1000,
      outS: Math.round(outS * 1000) / 1000,
      gestures: starts.map((s, i) => ({ from: s.t, to: ends[i].t, name: s.gesture })),
      flags: flags.join(""),
      numbers: got.summary ?? numbers,
      takes: got.takes,
      perGesture: gestures,
      kind: meta.events.find((e) => e.mark === "done")?.kind ?? null,
    };
  }
  return { label, scenes };
}

const before = side(load(flag("before")), flag("before-label", "HEAD 4348169"), "before");
const after = argv.includes("--after") ? side(load(flag("after")), flag("after-label", "after"), "after") : null;
const timeline = { kind: flag("kind", Object.values(before.scenes)[0]?.kind ?? "pan"), before, after };
const out = join(videos, "src/videos/scroll-perf/timeline.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(timeline, null, 1));
console.log(`wrote ${out}${existsSync(out) ? "" : " (missing?)"}`);
for (const [scene, s] of Object.entries(before.scenes)) console.log(`${scene}: before ${s.take} ${JSON.stringify(s.numbers)}`);
if (after) for (const [scene, s] of Object.entries(after.scenes)) console.log(`${scene}: after ${s.take} ${JSON.stringify(s.numbers)}`);
