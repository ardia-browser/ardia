#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_ENTITLEMENTS, prepareApp } from "../../../../scripts/lib/app-copy.mjs";
import { launch, session, sleep } from "../../../../scripts/lib/instance.mjs";
import { framesLibrary } from "./frames-phase.mjs";
import { median } from "./median.mjs";

const HELP = `Profile swipe cost: two-finger horizontal trackpad gestures (the shape of acperf postscroll trackpad-x: 0.3 s of
finger events with phases, then ~1.2 s of momentum, at 120 events/s) made in the app's own process by acswipe.dylib
(CGEvent → NSEvent → -[NSApplication sendEvent:], so they take AppKit's path, the swipe monitor included, without
needing the event-posting permission that acperf postscroll does), over the sidebar or the top tab strip.

  node apps/browser/scripts/perf/swipe-bench.mjs <Debug or Release Ardia.app> <scratch dir> --side <label>=<main.jsbundle>[@<Ardia.app>] [--side …]
       [--profiles 1,2] [--tabs 30,100] [--layouts sidebar,top] [--cases sb-fwd,sb-back,sb-tour,top-back,top-fwd] [--reps 5]
       [--settle 1500] [--port 9621] [--out FILE.json] [--laps 2] [--loaded] [--pointer] [--sample] [--mid-read MS]
       [--warmup 6000] [--timeline] [--film DIR] [--film-crop x,y,w,h] [--film-fps 120] [--film-scale 2]

  node apps/browser/scripts/perf/swipe-bench.mjs compare <result.json>

Each side is the app with that production bundle swapped in (prepareApp: injection entitlements, re-signed) and
served to it by a local stand-in for Metro (so a Debug app runs the production bundle too), started with
acframes.dylib (run-loop busy time of the main and JS threads, RCTUIManager layout passes and view updates) and
acswipe.dylib (the gestures, main-thread time inside -[NSApplication sendEvent:] for scroll events, the --trace sampler),
and the perf probe (React commits, renders, host updates, native→JS tasks such as event:onPagerPosition).
Every configuration (profiles × tabs × layout) gets one instance per side; the sides alternate gesture by gesture
(A B A B …), one gesture at a time. The session: N profiles with T tabs each from a local server, a 1360×820 window,
starting on the first profile.
A side's @<Ardia.app> runs that side on its own app (an older release beside a new build); without it every side runs
the app given first. Up to 6 profiles (Personal, Work, Play, School, Travel, Home).
Cases (the first profile is shown, so "back" has no profile before it):
  sb-fwd    over the sidebar, fingers moving left: with 2 profiles it pages to the next profile (then it's put back)
  sb-back   over the sidebar, fingers moving right: the rubber band at the first profile
  sb-tour   over the sidebar, a fresh instance per side and rep: swipes 1→2→…→N and back to 1, --laps times (default 2);
            the first lap forward is each profile's first visit, every other step a revisit. Each step is its own row
            ("tour fwd 2>3 first"), plus "tour all first" and "tour all revisit" pooling them.
  top-back  over the top strip, its first tab selected and the strip scrolled to its start in-process first: the strip can't scroll back, so the gesture
            goes to the pager (rubber band)
  top-fwd   over the top strip, its last tab selected and the strip scrolled to its end in-process first: pages to the next profile with 2 profiles (then
            it's put back). With --tabs 8 the strip fits and can't scroll at all.
An in-process phased gesture doesn't move an NSScrollView (AppKit tracks those from the window server), so a gesture the
pager passes on to the strip (or the sidebar) costs its routing here, not a scroll.
Rows per gesture (window: the gesture plus --settle ms): mainMs and jsMs (run-loop busy), sendEventMs (scroll events
inside sendEvent), cpuMs (the app process), commits, renders, hostUpdates, events (native→JS event tasks) and the top
event names, layoutPasses, viewUpdates, and whether the profile changed.
movingMs is the span from the first to the last sample where the view under the pointer moved; movingGapMs, movingMainMs
and movingCommits are the longest display-tick gap, the main thread's busy time and the React commits inside it (a
commit there is a hitch in the slide).
Every gesture also samples, every 4 ms, the window x of the view under the pointer (frames + presentation-layer
translations, minus the scroll offsets above it): travel (points moved in all), reversals (direction changes),
maxJump (largest change between two samples) and the range, so a run where nothing moved can't pass as a win.
ticks and longestGapMs are acframes.m's display-link ticks in the window (they tick at ~60 Hz even while locked).
Inside the slide: frames, p50GapMs/p95GapMs, longFrames (gaps over 1.5× the display's refresh interval), droppedFrames
(the refresh intervals those gaps swallowed) and longAt (each long gap's start in ms from the slide's start, and its
length); rssMb and cpuTreeMs are the instance's processes (app and helpers) at the end of the window.
The display must be awake (caffeinate -d -u): a sleeping display stops the display link and every frame row reads 0.
--loaded activates every tab of every profile before timing, so pages exist (the tabs otherwise restore unloaded).
--pointer puts a still pointer over the sidebar where the gesture runs (NSEvent mouseLocation and the window under
it are faked in-process), as under a real trackpad swipe.
--sample samples the main thread every 0.5 ms for 1.4 s from each gesture into main-sample-*.txt in the data dir.
--mid-read MS reads the probe's commits and renders MS after each gesture starts (what rendered inside the slide).
--timeline keeps each gesture's position samples and display ticks (ms from the gesture) in the results.
--film DIR records the --film-crop part of each window (default the sidebar, 0,0,300,820) in-process with
apps/videos/scripts/fixes/selfrec.m in layer mode, one movie per side and rep.`;

const ROWS = ["travel", "movingMs", "movingGapMs", "p95GapMs", "longFrames", "droppedFrames", "movingMainMs", "movingCommits", "rssMb", "cpuTreeMs", "mainMs", "jsMs", "cpuMs", "sendEventMs", "commits", "renders", "hostUpdates", "events", "layoutPasses", "viewUpdates", "ticks", "longestGapMs"];
const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help") || argv.length < 2) {
  console.log(HELP);
  process.exit(argv.length < 2 ? 1 : 0);
}
if (argv[0] === "compare") {
  compare(argv[1]);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const [appArg, scratchArg] = argv;
const app = resolve(appArg);
const scratch = resolve(scratchArg);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const flags = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const sides = flags("side").map((s) => {
  const [bundle, sideApp] = s.slice(s.indexOf("=") + 1).split("@");
  return { label: s.slice(0, s.indexOf("=")), bundle: resolve(bundle), app: sideApp ? resolve(sideApp) : null };
});
if (!sides.length) throw new Error("pass at least one --side <label>=<main.jsbundle>");
const profileCounts = flag("profiles", "1,2").split(",").map(Number);
const tabCounts = flag("tabs", "30,100").split(",").map(Number);
const layouts = flag("layouts", "sidebar,top").split(",");
const caseFilter = flag("cases", null)?.split(",");
const reps = Number(flag("reps", "5"));
const settle = Number(flag("settle", "1500"));
const basePort = Number(flag("port", "9621"));
const sampleMain = argv.includes("--sample");
const outFile = resolve(flag("out", join(scratch, `swipe-bench-${Date.now()}.json`)));

const PROFILE_NAMES = ["Personal", "Work", "Play", "School", "Travel", "Home"];
const CASES = {
  sidebar: [
    { name: "sb-fwd", at: { x: 140, y: 420 }, reverse: false },
    { name: "sb-back", at: { x: 140, y: 420 }, reverse: true },
    { name: "sb-tour", at: { x: 140, y: 420 }, tour: true },
  ],
  top: [
    { name: "top-back", at: { x: 640, y: 21 }, reverse: true, strip: "start" },
    { name: "top-fwd", at: { x: 640, y: 21 }, reverse: false, strip: "end" },
  ],
};

const toolDir = join(scratch, "tools");
mkdirSync(toolDir, { recursive: true });

function acperfBin() {
  const bin = join(toolDir, "acperf");
  const src = join(here, "acperf.swift");
  if (!existsSync(bin) || readFileSync(src, "utf8") !== (existsSync(bin + ".src") ? readFileSync(bin + ".src", "utf8") : "")) {
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    writeFileSync(bin + ".src", readFileSync(src, "utf8"));
  }
  return bin;
}

function swipeLibrary() {
  const lib = join(toolDir, "acswipe.dylib");
  const src = join(here, "acswipe.m");
  if (!existsSync(lib) || readFileSync(src, "utf8") !== (existsSync(lib + ".src") ? readFileSync(lib + ".src", "utf8") : "")) {
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", "-framework", "AppKit", "-framework", "QuartzCore", "-arch", "arm64", src, "-o", lib], { stdio: "inherit" });
    execFileSync("codesign", ["--force", "--sign", "-", lib]);
    writeFileSync(lib + ".src", readFileSync(src, "utf8"));
  }
  return lib;
}

const filmDir = flag("film", null) && resolve(flag("film", null));

function selfrecLibrary() {
  const lib = join(toolDir, "selfrec.dylib");
  const src = join(here, "../../../videos/scripts/fixes/selfrec.m");
  if (!existsSync(lib) || readFileSync(src, "utf8") !== (existsSync(lib + ".src") ? readFileSync(lib + ".src", "utf8") : "")) {
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", "-framework", "AppKit", "-framework", "AVFoundation", "-framework", "CoreMedia", "-framework", "CoreVideo", "-framework", "QuartzCore", "-arch", "arm64", src, "-o", lib], { stdio: "inherit" });
    execFileSync("codesign", ["--force", "--sign", "-", lib]);
    writeFileSync(lib + ".src", readFileSync(src, "utf8"));
  }
  return lib;
}

const acperf = acperfBin();
const dylibs = [framesLibrary(toolDir, here), swipeLibrary(), ...(filmDir ? [selfrecLibrary()] : [])].join(":");

function startServer() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("/").filter(Boolean).join(" ") || "home");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${name}</title><body style="font:14px sans-serif">${name}</body>`);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function bundleServer(file) {
  const body = readFileSync(file);
  const server = createServer((req, res) => {
    if (req.url.startsWith("/status")) return res.end("packager-status:running");
    if (req.url.includes(".bundle")) {
      res.writeHead(200, { "content-type": "application/javascript", "content-length": body.length });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => socket.destroy());
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function seedSession(profiles, tabsEach, port) {
  const names = PROFILE_NAMES.slice(0, profiles);
  const ids = names.map((n, i) => (i ? n.toLowerCase() : "default"));
  const tabs = ids.flatMap((pid) =>
    Array.from({ length: tabsEach }, (_, n) => ({ id: `${pid}-t${n}`, profileId: pid, url: `http://127.0.0.1:${port}/${pid}/tab${n}`, title: `${pid} tab ${n}`, lastActiveAt: n + 1 })),
  );
  const s = session({ profiles: names, windows: [{ id: "w1", frame: [60, 60, 1360, 820], sidebarOpen: true }], tabs });
  s.windows[0].tabIds = tabs.map((t) => t.id);
  s.windows[0].activeTabIds = Object.fromEntries(ids.map((pid) => [pid, `${pid}-t0`]));
  return { session: s, ids, tabIds: tabs.filter((t) => t.profileId === ids[0]).map((t) => t.id) };
}

const windowsOf = (pid) =>
  JSON.parse(
    execFileSync("osascript", ["-l", "JavaScript", "-e",
      `ObjC.import("CoreGraphics"); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)))
        .filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer <= 0 && w.kCGWindowBounds.Width >= 600).map((w) => ({ id: w.kCGWindowNumber, b: w.kCGWindowBounds })))`], { timeout: 20000 }).toString(),
  );

let cmdSeq = 0;
async function native(inst, file, body, timeout = 5000) {
  const id = `c${process.pid}-${++cmdSeq}`;
  const result = join(inst.data, file.replace("cmd", "result"));
  writeFileSync(join(inst.data, file), JSON.stringify({ ...body, id }));
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(10)) {
    try {
      const out = JSON.parse(readFileSync(result, "utf8"));
      if (out.id === id) return out;
    } catch {}
  }
  throw new Error(`${file} ${body.op} timed out`);
}
const frames = (inst, op) => native(inst, "bench-frames-cmd.json", { op });
const swipeProbe = (inst, body, timeout) => native(inst, "bench-swipe-cmd.json", body, timeout);

function cpuMs(pid) {
  const r = spawnSync(acperf, ["rusage", String(pid)], { encoding: "utf8" });
  return JSON.parse(r.stdout.trim().split("\n")[0]).cpuNs / 1e6;
}

function treeUsage(inst) {
  const out = spawnSync("ps", ["-Ao", "rss=,time=,command="], { encoding: "utf8" }).stdout ?? "";
  let rss = 0, cpu = 0;
  for (const line of out.split("\n")) {
    if (!line.includes(inst.app)) continue;
    const m = line.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s/);
    if (!m) continue;
    rss += Number(m[1]);
    cpu += ((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 3600 + Number(m[4]) * 60 + Number(m[5])) * 1000;
  }
  return { rssMb: Math.round(rss / 1024), cpuTreeMs: Math.round(cpu) };
}

function busy(inst, from, to) {
  let text = "";
  try {
    text = readFileSync(join(inst.data, "bench-frames.jsonl"), "utf8");
  } catch {}
  const out = { m: 0, j: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"k":"r"')) continue;
    const r = JSON.parse(line);
    const start = Math.max(r.a, from), end = Math.min(r.a + r.d, to);
    if (end > start) out[r.th] += end - start;
  }
  return out;
}

async function post(inst, win, at, reverse) {
  const r = await swipeProbe(inst, { op: "gesture", window: win.id, x: at.x, y: at.y, reverse, rate: 120 }, 10000);
  if (!r.ok) throw new Error(`gesture: ${r.error}`);
  return r;
}

const PROBE_READ = `
  const st = acPerf.read();
  const sum = (c) => Object.values(c ?? {}).reduce((a, b) => a + b, 0);
  const events = Object.entries(st.tasks ?? {}).filter(([k]) => k.startsWith("event:"));
  return {
    commits: st.commits, renders: sum(st.renders), hostUpdates: st.hostUpdates,
    commitAt: (st.commitTimes ?? []).map((t) => Math.round(t + Date.now() - performance.now())),
    events: events.reduce((a, [, v]) => a + v, 0),
    eventMs: Math.round(Object.entries(st.taskMs ?? {}).filter(([k]) => k.startsWith("event:")).reduce((a, [, v]) => a + v, 0) * 10) / 10,
    eventsBy: Object.fromEntries(events.sort((a, b) => b[1] - a[1]).slice(0, 4)),
    rendersBy: Object.fromEntries(Object.entries(st.renders ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6)),
    profile: ac.store.getState().windows[ac.store.getState().windowOrder[0]].profileId,
  };
`;

async function resetProfile(inst, first) {
  const changed = await inst.eval(`const s = ac.store.getState(); const w = s.windowOrder[0]; if (s.windows[w].profileId === ${JSON.stringify(first)}) return false; s.switchProfile(w, ${JSON.stringify(first)}); return true;`);
  if (changed) await sleep(1200);
}

async function gesture(inst, win, c, first, ids, { reset = true, reverse = c.reverse } = {}) {
  if (reset) await resetProfile(inst, first);
  const from = await inst.eval(`return ac.store.getState().windows[ac.store.getState().windowOrder[0]].profileId;`);
  if (c.strip) {
    const last = ids.at(-1);
    await inst.eval(`ac.store.getState().activate(${JSON.stringify(c.strip === "end" ? last : ids[0])}); return 1;`);
    await sleep(700);
    const r = await swipeProbe(inst, { op: "scroll", window: win.id, x: c.at.x, y: c.at.y, to: c.strip });
    if (!r.ok) throw new Error(`strip scroll: ${r.error}`);
  }
  await sleep(500);
  const started = await swipeProbe(inst, { op: "trace", window: win.id, x: c.at.x, y: c.at.y });
  await inst.eval("acPerf.reset(); return 1;");
  const f0 = await frames(inst, "counters");
  const s0 = await swipeProbe(inst, { op: "counters" });
  await swipeProbe(inst, { op: "resetMax" });
  if (sampleMain) {
    const sampling = await swipeProbe(inst, { op: "sample", ms: 1400 });
    if (!sampling.ok) throw new Error(`sample: ${sampling.error}`);
  }
  const cpu0 = cpuMs(inst.pid);
  const t0 = Date.now();
  const midRead = Number(flag("mid-read", "0"));
  let mid = null;
  const posting = post(inst, win, c.at, reverse);
  posting.catch(() => {});
  if (midRead) {
    await sleep(midRead);
    mid = await inst.eval(`const st = acPerf.read(); return { commits: st.commits, rendersBy: Object.fromEntries(Object.entries(st.renders ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 25)) };`);
  }
  const posted = await posting;
  await sleep(settle);
  const t1 = Date.now();
  const cpu1 = cpuMs(inst.pid);
  const usage = treeUsage(inst);
  const f1 = await frames(inst, "counters");
  const s1 = await swipeProbe(inst, { op: "counters" });
  const probe = await inst.eval(PROBE_READ);
  const { samples } = await swipeProbe(inst, { op: "untrace" });
  if (sampleMain) for (let k = 0; k < 200 && (await swipeProbe(inst, { op: "sampling" })).busy; k++) await sleep(50);
  await sleep(120);
  const b = busy(inst, t0, t1);
  const fr = frameStats(inst, t0, t1);
  const r = (x) => Math.round(x * 10) / 10;
  const m = motion(samples);
  const moving = movingSpan(samples.filter(([at]) => at >= t0 && at <= t1));
  const during = moving ? frameStats(inst, moving[0], moving[1]) : { ticks: 0, longestGapMs: 0, gaps: [] };
  const dist = gapDistribution(during.gaps ?? [], refreshMs(inst), moving?.[0] ?? 0);
  const busyMoving = moving ? busy(inst, moving[0], moving[1]) : { m: 0, j: 0 };
  const { commitAt, ...probeRest } = probe;
  return {
    posted: posted.events, chain: started.chain?.slice(0, 4),
    mainMs: r(b.m), jsMs: r(b.j), cpuMs: r(cpu1 - cpu0),
    sendEventMs: r(s1.scrollMs - s0.scrollMs), sendEventMaxMs: r(s1.scrollMaxMs), scrollEvents: s1.scrollEvents - s0.scrollEvents,
    layoutPasses: f1.layoutPasses - f0.layoutPasses, viewUpdates: f1.viewUpdates - f0.viewUpdates, uiBlocks: f1.uiBlocks - f0.uiBlocks,
    ticks: fr.ticks, longestGapMs: fr.longestGapMs,
    movingMs: moving ? Math.round(moving[1] - moving[0]) : 0, movingGapMs: during.longestGapMs, movingMainMs: r(busyMoving.m),
    movingCommits: moving ? commitAt.filter((t) => t >= moving[0] && t <= moving[1]).length : 0,
    ...dist, commitsAt: moving ? commitAt.map((t) => Math.round(t - moving[0])) : [],
    travel: m.travel, moves: m.moves, reversals: m.reversals, maxJump: m.maxJump, range: [m.min, m.max], series: m.series,
    ...probeRest, from, to: probe.profile, paged: probe.profile !== from, gestureAt: t0, movingAt: moving?.[0] ?? null, mid, ...usage,
    ...(argv.includes("--timeline") ? { timeline: { samples: samples.map((x) => [Math.round((x[0] - t0) * 10) / 10, Math.round((x[1] - x[2]) * 10) / 10]), ticks: tickTimes(inst, t0, t1).map((t) => Math.round((t - t0) * 10) / 10) } } : {}),
  };
}

function movingSpan(samples) {
  let first = null, last = null;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i][1] - samples[i][2] - (samples[i - 1][1] - samples[i - 1][2])) < 0.01) continue;
    first ??= samples[i - 1][0];
    last = samples[i][0];
  }
  return first === null ? null : [first, last];
}

function frameStats(inst, from, to) {
  let text = "";
  try {
    text = readFileSync(join(inst.data, "bench-frames.jsonl"), "utf8");
  } catch {}
  const ts = [];
  let before = null, after = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"k":"f"')) continue;
    const f = JSON.parse(line);
    if (f.now >= from && f.now <= to) ts.push(f.now);
    else if (f.now < from) before = before === null ? f.now : Math.max(before, f.now);
    else after = after === null ? f.now : Math.min(after, f.now);
  }
  ts.sort((a, b) => a - b);
  const spanning = [...(before === null ? [] : [before]), ...ts, ...(after === null ? [] : [after])];
  let gap = 0;
  const gaps = [];
  for (let i = 1; i < spanning.length; i++) {
    const start = Math.max(spanning[i - 1], from);
    const inside = Math.min(spanning[i], to) - start;
    if (inside <= 0) continue;
    gap = Math.max(gap, inside);
    gaps.push([start, inside]);
  }
  return { ticks: ts.length, longestGapMs: Math.round(gap * 10) / 10, gaps };
}

function tickTimes(inst, from, to) {
  let text = "";
  try {
    text = readFileSync(join(inst.data, "bench-frames.jsonl"), "utf8");
  } catch {}
  const ts = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"k":"f"')) continue;
    const f = JSON.parse(line);
    if (f.now >= from && f.now <= to) ts.push(f.now);
  }
  return ts;
}

const refreshCache = new Map();
function refreshMs(inst) {
  if (refreshCache.has(inst.data)) return refreshCache.get(inst.data);
  let fps = 0;
  try {
    const line = readFileSync(join(inst.data, "bench-frames.jsonl"), "utf8").split("\n").find((l) => l.startsWith('{"k":"info"'));
    fps = line ? JSON.parse(line).maxFPS : 0;
  } catch {}
  const ms = 1000 / (fps || 120);
  if (fps) refreshCache.set(inst.data, ms);
  return ms;
}

function gapDistribution(gaps, refresh, origin) {
  const sorted = gaps.map(([, g]) => g).sort((a, b) => a - b);
  const pick = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const r = (x) => Math.round(x * 10) / 10;
  const long = gaps.filter(([, g]) => g > 1.5 * refresh);
  return {
    refreshMs: r(refresh), frames: gaps.length + (gaps.length ? 1 : 0),
    longFrames: long.length, droppedFrames: long.reduce((n, [, g]) => n + Math.max(0, Math.round(g / refresh) - 1), 0),
    p95GapMs: r(pick(0.95)), p50GapMs: r(pick(0.5)),
    longAt: long.map(([t, g]) => [Math.round(t - origin), r(g)]),
  };
}

function motion(samples) {
  const xs = samples.map((s) => s[1] - s[2]);
  let moves = 0, reversals = 0, maxJump = 0, lastSign = 0, travel = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (Math.abs(d) < 0.01) continue;
    moves++;
    travel += Math.abs(d);
    maxJump = Math.max(maxJump, Math.abs(d));
    const sign = Math.sign(d);
    if (lastSign && sign !== lastSign) reversals++;
    lastSign = sign;
  }
  return { samples: xs.length, travel: Math.round(travel), moves, reversals, maxJump: Math.round(maxJump * 10) / 10, min: Math.min(...xs), max: Math.max(...xs), series: xs.map((x) => Math.round(x * 10) / 10) };
}



function pooledTours(cases) {
  const pools = {};
  for (const [name, bySide] of Object.entries(cases)) {
    const m = name.match(/^tour \w+ \S+ (first|revisit)$/);
    if (!m) continue;
    const key = `tour all ${m[1]}`;
    pools[key] ??= {};
    for (const [label, runs] of Object.entries(bySide)) (pools[key][label] ??= []).push(...runs);
  }
  return pools;
}

function summarize(results) {
  const lines = [];
  for (const [config, cases] of Object.entries(results.runs))
    for (const [name, bySide] of [...Object.entries(cases), ...Object.entries(pooledTours(cases))]) {
      const row = { config, case: name };
      for (const [label, runs] of Object.entries(bySide)) {
        const timed = runs;
        row[label] = Object.fromEntries(ROWS.map((k) => [k, median(timed.map((r) => r[k]))]));
        row[label].n = timed.length;
        row[label].paged = timed.filter((r) => r.paged).length;
        row[label].reversals = median(timed.map((r) => r.reversals));
        row[label].maxJump = median(timed.map((r) => r.maxJump));
      }
      lines.push(row);
    }
  return lines;
}

function printSummary(lines) {
  for (const row of lines) {
    console.log(`\n${row.config} ${row.case}`);
    const labels = Object.keys(row).filter((k) => k !== "config" && k !== "case");
    console.log(`  ${"".padEnd(13)}${labels.map((l) => l.padStart(12)).join("")}`);
    for (const k of [...ROWS, "reversals", "maxJump", "n", "paged"]) console.log(`  ${k.padEnd(13)}${labels.map((l) => String(row[l][k]).padStart(12)).join("")}`);
  }
}

function compare(file) {
  printSummary(summarize(JSON.parse(readFileSync(file, "utf8"))));
}

const logLine = (name, label, i, g) =>
  console.log(`${name} ${label} #${i + 1}: ${g.from}>${g.to} travel ${g.travel} rev ${g.reversals} main ${g.mainMs} js ${g.jsMs} commits ${g.commits} layout ${g.layoutPasses} views ${g.viewUpdates} | moving ${g.movingMs}ms frames ${g.frames} long ${g.longFrames} dropped ${g.droppedFrames} p95 ${g.p95GapMs} max ${g.movingGapMs} main ${g.movingMainMs} commits ${g.movingCommits} ${JSON.stringify(g.longAt)} c@${JSON.stringify(g.commitsAt)}`);

async function launchSides(apps, seeded, profiles, tabsEach, layout, tag) {
  const instances = [];
  try {
    return await prepareSides(instances, apps, seeded, profiles, tabsEach, layout, tag);
  } catch (e) {
    for (const { inst } of instances) await inst.quit().catch(() => {});
    throw e;
  }
}

async function prepareSides(instances, apps, seeded, profiles, tabsEach, layout, tag) {
  for (const side of apps) {
    const data = join(scratch, "data", `${side.label}-p${profiles}-t${tabsEach}-${layout}${tag}`);
    rmSync(data, { recursive: true, force: true });
    const inst = await launch(side.app, {
      data, fresh: true, session: seeded.session, onboarded: true, port: basePort + apps.indexOf(side), js: `127.0.0.1:${side.server.address().port}`,
      files: { "perf-probe": "" },
      env: { DYLD_INSERT_LIBRARIES: dylibs, AC_BENCH_FRAMES: "1", AC_BENCH_SWIPE: "1", ...(filmDir ? { FIXES_SELFREC_DIR: join(data, "selfrec"), FIXES_SELFREC_LAYERS: "1", FIXES_SELFREC_CROP: flag("film-crop", "0,0,300,820"), FIXES_SELFREC_SCALE: flag("film-scale", "2") } : {}) },
    });
    instances.push({ side, inst });
    const dev = await inst.eval("return __DEV__;");
    if (dev) throw new Error(`${side.label}: the instance runs development JS, not ${side.bundle}`);
    await inst.eval(`ac.store.getState().updateSettings({ tabLayout: ${JSON.stringify(layout === "top" ? "top" : "sidebar")} }); return 1;`);
  }
  await sleep(Number(flag("warmup", "6000")));
  if (argv.includes("--loaded")) {
    const step = Number(flag("load-step", "60"));
    for (const pid of seeded.ids) {
      const tabs = seeded.session.tabs.filter((t) => t.profileId === pid).map((t) => t.id);
      for (const { inst } of instances)
        await inst.eval(`const s = ac.store.getState(); const w = s.windowOrder[0]; s.switchProfile(w, ${JSON.stringify(pid)}); const ids = ${JSON.stringify(tabs)}; ids.forEach((id, i) => setTimeout(() => ac.store.getState().activate(id), 300 + i * ${step})); return 1;`);
      await sleep(300 + tabs.length * step + 1500);
    }
    for (const { inst } of instances)
      await inst.eval(`const s = ac.store.getState(); const w = s.windowOrder[0]; s.switchProfile(w, ${JSON.stringify(seeded.ids[0])}); setTimeout(() => ac.store.getState().activate(${JSON.stringify(seeded.tabIds[0])}), 300); return 1;`);
    await sleep(4000);
  }
  for (const { side, inst } of instances) {
    const wins = windowsOf(inst.pid);
    if (!wins.length) throw new Error(`${side.label}: no window on screen`);
    side.win = wins[0];
  }
  if (argv.includes("--pointer"))
    for (const { side, inst } of instances) {
      const r = await swipeProbe(inst, { op: "pointer", window: side.win.id, x: 140, y: 420 });
      if (!r.ok) throw new Error(`pointer: ${r.error}`);
    }
  return instances;
}

function tourSteps(profiles, laps) {
  const steps = [];
  const seen = new Set([0]);
  for (let lap = 0; lap < laps; lap++) {
    for (let k = 0; k < profiles - 1; k++) {
      steps.push({ reverse: false, from: k, to: k + 1, visit: seen.has(k + 1) ? "revisit" : "first" });
      seen.add(k + 1);
    }
    for (let k = profiles - 1; k > 0; k--) steps.push({ reverse: true, from: k, to: k - 1, visit: "revisit" });
  }
  return steps.map((st) => ({ ...st, name: `tour ${st.reverse ? "back" : "fwd"} ${st.from + 1}>${st.to + 1} ${st.visit}` }));
}

async function runTour(apps, c, seeded, profiles, tabsEach, layout, out, save, config) {
  const steps = tourSteps(profiles, Number(flag("laps", "2")));
  for (const st of steps) out[st.name] ??= Object.fromEntries(apps.map((s) => [s.label, []]));
  for (let i = 0; i < reps; i++) {
    const ordered = i % 2 ? [...apps].reverse() : apps;
    const instances = await launchSides(ordered, seeded, profiles, tabsEach, layout, `-tour${i + 1}`);
    try {
      const films = filmDir ? instances.map(({ side, inst }) => filmStart(inst, join(filmDir, config.replace(/\s+/g, "-"), `${side.label}-${i + 1}.mov`))) : [];
      const offTour = new Set();
      for (const st of steps)
        for (const { side, inst } of instances) {
          if (offTour.has(side.label)) continue;
          const g = await gesture(inst, side.win, c, seeded.ids[0], seeded.tabIds, { reset: false, reverse: st.reverse });
          g.expected = seeded.ids[st.to];
          if (g.from !== seeded.ids[st.from] || g.to !== seeded.ids[st.to]) {
            console.log(`  ! ${side.label} ${st.name}: went ${g.from}>${g.to}; the rest of this lap is dropped for ${side.label}`);
            offTour.add(side.label);
            continue;
          }
          out[st.name][side.label].push(g);
          logLine(`${config} ${st.name}`, side.label, i, g);
        }
      for (const film of films) await film.stop();
    } finally {
      for (const { inst } of instances) await inst.quit().catch(() => {});
    }
    save();
  }
}

function filmStart(inst, out) {
  mkdirSync(dirname(out), { recursive: true });
  const dir = join(inst.data, "selfrec");
  const status = join(dir, "status");
  rmSync(status, { force: true });
  const id = `${Date.now()}${Math.random()}`;
  writeFileSync(join(dir, "cmd"), `start\t${id}\t${out}\t${flag("film-fps", "120")}\t300`);
  const read = () => (existsSync(status) ? readFileSync(status, "utf8") : "");
  return {
    async stop() {
      writeFileSync(join(dir, "cmd"), `stop\t${id}`);
      for (const end = Date.now() + 25000; Date.now() < end; await sleep(100)) if (/^(finished|error)/m.test(read())) break;
      writeFileSync(out.replace(/\.mov$/, ".status.txt"), read());
    },
  };
}

async function run() {
  mkdirSync(scratch, { recursive: true });
  const apps = sides.map((s) => ({ ...s, app: prepareApp(s.app ?? app, join(scratch, "apps", s.label), { bundle: s.bundle, entitlements: INJECTION_ENTITLEMENTS }) }));
  const server = await startServer();
  for (const side of apps) side.server = await bundleServer(side.bundle);
  const results = { at: new Date().toISOString(), app, sides: sides.map(({ label, bundle, app: a }) => ({ label, bundle, app: a ?? app })), settle, runs: {} };
  const save = () => writeFileSync(outFile, JSON.stringify(results, null, 2));
  try {
    for (const profiles of profileCounts)
      for (const tabsEach of tabCounts)
        for (const layout of layouts) {
          const config = `p${profiles} t${tabsEach} ${layout}`;
          const cases = CASES[layout].filter((c) => !caseFilter || caseFilter.includes(c.name));
          if (!cases.length) continue;
          const seeded = seedSession(profiles, tabsEach, server.address().port);
          const out = (results.runs[config] = {});
          const tours = cases.filter((c) => c.tour);
          const singles = cases.filter((c) => !c.tour);
          for (const c of tours) await runTour(apps, c, seeded, profiles, tabsEach, layout, out, save, config);
          if (!singles.length) continue;
          const instances = await launchSides(apps, seeded, profiles, tabsEach, layout, "");
          try {
            for (const c of singles) {
              out[c.name] = Object.fromEntries(apps.map((s) => [s.label, []]));
              for (let i = 0; i < reps; i++)
                for (const { side, inst } of i % 2 ? [...instances].reverse() : instances) {
                  const g = await gesture(inst, side.win, c, seeded.ids[0], seeded.tabIds);
                  out[c.name][side.label].push(g);
                  logLine(`${config} ${c.name}`, side.label, i, g);
                }
              save();
            }
          } finally {
            for (const { inst } of instances) await inst.quit().catch(() => {});
          }
        }
  } finally {
    results.summary = summarize(results);
    save();
    server.close();
    for (const side of apps) side.server?.close();
    printSummary(results.summary);
    console.log(`\nresults: ${outFile}`);
  }
}

run().catch((e) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
