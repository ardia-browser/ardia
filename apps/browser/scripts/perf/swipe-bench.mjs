#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_ENTITLEMENTS, prepareApp } from "../../../../scripts/lib/app-copy.mjs";
import { launch, session, sleep } from "../../../../scripts/lib/instance.mjs";
import { framesLibrary } from "./frames-phase.mjs";

const HELP = `Profile swipe cost: two-finger horizontal trackpad gestures (the shape of acperf postscroll trackpad-x: 0.3 s of
finger events with phases, then ~1.2 s of momentum, at 120 events/s) made in the app's own process by acswipe.dylib
(CGEvent → NSEvent → -[NSApplication sendEvent:], so they take AppKit's path, the swipe monitor included, without
needing the event-posting permission that acperf postscroll does), over the sidebar or the top tab strip.

  node apps/browser/scripts/perf/swipe-bench.mjs <Debug or Release Ardia.app> <scratch dir> --side <label>=<main.jsbundle> [--side …]
       [--profiles 1,2] [--tabs 30,100] [--layouts sidebar,top] [--cases sb-fwd,sb-back,top-back,top-fwd] [--reps 5]
       [--settle 1500] [--port 9621] [--out FILE.json]

  node apps/browser/scripts/perf/swipe-bench.mjs compare <result.json>

Each side is the app with that production bundle swapped in (prepareApp: injection entitlements, re-signed) and
served to it by a local stand-in for Metro (so a Debug app runs the production bundle too), started with
acframes.dylib (run-loop busy time of the main and JS threads, RCTUIManager layout passes and view updates) and
acswipe.dylib (the gestures, main-thread time inside -[NSApplication sendEvent:] for scroll events, the --trace sampler),
and the perf probe (React commits, renders, host updates, native→JS tasks such as event:onPagerPosition).
Every configuration (profiles × tabs × layout) gets one instance per side; the sides alternate gesture by gesture
(A B A B …), one gesture at a time. The session: N profiles with T tabs each from a local server, a 1360×820 window,
starting on the first profile.
Cases (the first profile is shown, so "back" has no profile before it):
  sb-fwd    over the sidebar, fingers moving left: with 2 profiles it pages to the next profile (then it's put back)
  sb-back   over the sidebar, fingers moving right: the rubber band at the first profile
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
ticks and longestGapMs are acframes.m's display-link ticks in the window (they tick at ~60 Hz even while locked).`;

const ROWS = ["travel", "movingMs", "movingGapMs", "movingMainMs", "movingCommits", "mainMs", "jsMs", "cpuMs", "sendEventMs", "commits", "renders", "hostUpdates", "events", "layoutPasses", "viewUpdates", "ticks", "longestGapMs"];
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
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
const sides = flags("side").map((s) => ({ label: s.slice(0, s.indexOf("=")), bundle: resolve(s.slice(s.indexOf("=") + 1)) }));
if (!sides.length) throw new Error("pass at least one --side <label>=<main.jsbundle>");
const profileCounts = flag("profiles", "1,2").split(",").map(Number);
const tabCounts = flag("tabs", "30,100").split(",").map(Number);
const layouts = flag("layouts", "sidebar,top").split(",");
const caseFilter = flag("cases", null)?.split(",");
const reps = Number(flag("reps", "5"));
const settle = Number(flag("settle", "1500"));
const basePort = Number(flag("port", "9621"));
const outFile = resolve(flag("out", join(scratch, `swipe-bench-${Date.now()}.json`)));

const PROFILE_NAMES = ["Personal", "Work", "Play"];
const CASES = {
  sidebar: [
    { name: "sb-fwd", at: { x: 140, y: 420 }, reverse: false },
    { name: "sb-back", at: { x: 140, y: 420 }, reverse: true },
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

const acperf = acperfBin();
const dylibs = [framesLibrary(toolDir, here), swipeLibrary()].join(":");

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

async function gesture(inst, win, c, first, ids) {
  await resetProfile(inst, first);
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
  const cpu0 = cpuMs(inst.pid);
  const t0 = Date.now();
  const posted = await post(inst, win, c.at, c.reverse);
  await sleep(settle);
  const t1 = Date.now();
  const cpu1 = cpuMs(inst.pid);
  const f1 = await frames(inst, "counters");
  const s1 = await swipeProbe(inst, { op: "counters" });
  const probe = await inst.eval(PROBE_READ);
  const { samples } = await swipeProbe(inst, { op: "untrace" });
  await sleep(120);
  const b = busy(inst, t0, t1);
  const fr = frameStats(inst, t0, t1);
  const r = (x) => Math.round(x * 10) / 10;
  const m = motion(samples);
  const moving = movingSpan(samples);
  const during = moving ? frameStats(inst, moving[0], moving[1]) : { ticks: 0, longestGapMs: 0 };
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
    travel: m.travel, moves: m.moves, reversals: m.reversals, maxJump: m.maxJump, range: [m.min, m.max], series: m.series,
    ...probeRest, paged: probe.profile !== first,
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
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"k":"f"')) continue;
    const f = JSON.parse(line);
    if (f.now >= from && f.now <= to) ts.push(f.now);
  }
  let gap = 0;
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
  return { ticks: ts.length, longestGapMs: Math.round(gap * 10) / 10 };
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



function summarize(results) {
  const lines = [];
  for (const [config, cases] of Object.entries(results.runs))
    for (const [name, bySide] of Object.entries(cases)) {
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

async function run() {
  mkdirSync(scratch, { recursive: true });
  const apps = sides.map((s) => ({ ...s, app: prepareApp(app, join(scratch, "apps", s.label), { bundle: s.bundle, entitlements: INJECTION_ENTITLEMENTS }) }));
  const server = await startServer();
  for (const side of apps) side.server = await bundleServer(side.bundle);
  const results = { at: new Date().toISOString(), app, sides: sides.map(({ label, bundle }) => ({ label, bundle })), settle, runs: {} };
  const save = () => writeFileSync(outFile, JSON.stringify(results, null, 2));
  try {
    for (const profiles of profileCounts)
      for (const tabsEach of tabCounts)
        for (const layout of layouts) {
          const config = `p${profiles} t${tabsEach} ${layout}`;
          const cases = CASES[layout].filter((c) => !caseFilter || caseFilter.includes(c.name));
          if (!cases.length) continue;
          const seeded = seedSession(profiles, tabsEach, server.address().port);
          const instances = [];
          try {
            for (const side of apps) {
              const data = join(scratch, "data", `${side.label}-p${profiles}-t${tabsEach}-${layout}`);
              rmSync(data, { recursive: true, force: true });
              const inst = await launch(side.app, {
                data, fresh: true, session: seeded.session, onboarded: true, port: basePort + apps.indexOf(side), js: `127.0.0.1:${side.server.address().port}`,
                files: { "perf-probe": "" }, env: { DYLD_INSERT_LIBRARIES: dylibs, AC_BENCH_FRAMES: "1", AC_BENCH_SWIPE: "1" },
              });
              instances.push({ side, inst });
              const dev = await inst.eval("return __DEV__;");
              if (dev) throw new Error(`${side.label}: the instance runs development JS, not ${side.bundle}`);
              await inst.eval(`ac.store.getState().updateSettings({ tabLayout: ${JSON.stringify(layout === "top" ? "top" : "sidebar")} }); return 1;`);
            }
            await sleep(6000);
            for (const { side, inst } of instances) {
              const wins = windowsOf(inst.pid);
              if (!wins.length) throw new Error(`${side.label}: no window on screen`);
              side.win = wins[0];
            }
            const out = (results.runs[config] = {});
            for (const c of cases) {
              out[c.name] = Object.fromEntries(apps.map((s) => [s.label, []]));
              for (let i = 0; i < reps; i++)
                for (const { side, inst } of i % 2 ? [...instances].reverse() : instances) {
                  const g = await gesture(inst, side.win, c, seeded.ids[0], seeded.tabIds);
                  out[c.name][side.label].push(g);
                  console.log(`${config} ${c.name} ${side.label} #${i + 1}: travel ${g.travel} range ${g.range} rev ${g.reversals} main ${g.mainMs} js ${g.jsMs} cpu ${g.cpuMs} send ${g.sendEventMs} commits ${g.commits} renders ${g.renders} host ${g.hostUpdates} events ${g.events} ${JSON.stringify(g.eventsBy)} layout ${g.layoutPasses} views ${g.viewUpdates} ticks ${g.ticks} gap ${g.longestGapMs} moving ${g.movingMs}ms gap ${g.movingGapMs} main ${g.movingMainMs} commits ${g.movingCommits} paged ${g.paged}`);
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
