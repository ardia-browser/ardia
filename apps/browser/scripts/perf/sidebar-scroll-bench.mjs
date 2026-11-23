#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_ENTITLEMENTS, prepareApp } from "../../../../scripts/lib/app-copy.mjs";
import { attach, launch, session, sleep } from "../../../../scripts/lib/instance.mjs";
import { framesLibrary } from "./frames-phase.mjs";

const HELP = `Sidebar scroll cost with real gestures: what one trackpad flick or wheel spin over the sidebar's tab list costs the
app, at several tab counts, read while the screen may be locked.

  node apps/browser/scripts/perf/sidebar-scroll-bench.mjs run --app <Debug or Release Ardia.app> --scratch <dir>
      [--bundle <main.jsbundle>] [--label <name>] [--tabs 50,150,300] [--profiles 1,2] [--reps 5]
      [--gestures pan,pan-up,wheel,wheel-up] [--layout sidebar|top] [--pointer over|away] [--port 9631] [--keep] [--attach]
      [--post app|acperf] [--append] [--out <file.json>]
  node apps/browser/scripts/perf/sidebar-scroll-bench.mjs compare <before.json> <after.json>

run: --app is cloned (scripts/lib/app-copy.mjs) with the entitlements acframes.m's injection needs. --bundle is a
production bundle (js-bench.mjs bundle) served to the instance as its packager, so a Debug app runs it instead of Metro's
dev JS (slower, lies), which it runs without --bundle.
Each tab count x profile count gets one hidden instance (<scratch>/<label>/t<N>p<P>/data, DevTools port --port and up):
N tabs in the first profile (6 pinned tiles, 3 pinned rows, an expanded group of 5, a collapsed group of 4, two audible
and two forever-loading tabs, the rest plain), a second profile of 40 tabs when P is 2, tabLayout "sidebar", one
1280x860 window. Each rep posts every gesture at the sidebar's middle, 120 events/s. --post app (default) has acframes.m
post the scroll-wheel events (CGEvent → NSEvent, phases and momentum as acperf's) into the app's own event queue from a
background thread on their own clock, so they work while the screen is locked (WindowServer drops CGEventPostToPid scroll
events then); --post acperf posts them with acperf postscroll instead. Gestures:
  pan           a trackpad flick down as phaseless precise deltas: 0.3 s of finger deltas, then the decaying momentum
                deltas (1.5 s, about 2600 pt), from the top of the list
  pan-up        the same flick reversed, from where the last one stopped
  trackpad      the same flick with real phases (began/changed/ended, then momentum): needs an unlocked screen, a
                locked one stalls it after a few points (the window has no screen)
  wheel         12 wheel notches down, from the top
  wheel-up      12 notches back up
  open          a tab opened beside the shown one, as the + button does with Add new tabs set to next to the current tab
                (the fixture sets it whenever a tab action runs, so the new tab lands in view)
  close         the tab the last open made, closed as its ✕ does
  close-run     three tabs opened beside the shown one (not measured), then closed one after another 120 ms apart
--layout top lays the tabs out across the top instead (tabLayout "top"); open and close measure its strip the same way.
--pointer over (default) parks the hover pointer (ac.shell.devSetPointer, Debug builds) over the sidebar under the
gesture, as a real pointer is while you scroll; away parks it over the page.
Per gesture, over the gesture plus 700 ms: main- and JS-thread CPU ms (thread_info, read on each display-link tick) and
run-loop busy ms (acframes.m), the longest main run-loop iteration and how many ran over 8.3 ms (each costs a 120 Hz
frame; mainLong in the report lists when and how long), the display-link ticks on which the list had moved and how many of
those came over 1.5 display frames after the tick before (a frame dropped while it moved, the one you see; null with --post acperf, which samples no offsets), app process CPU ms (acperf rusage), display-link frames and the longest gap between them (about 63 Hz while locked), React commits, renders, host view updates, store updates, JS tasks from native events by name
(scroll and hover events), native view updates and layout passes (acframes counters), and how far the list moved.
Instances alternate nothing: run two labels in turn with --append to interleave builds (A B A B), e.g.
  for i in 1 2 3 4 5; do for s in base:A.jsbundle new:B.jsbundle; do
    node .../sidebar-scroll-bench.mjs run --app <app> --scratch <dir> --label \${s%%:*} --bundle \${s#*:} --reps 1 --append
  done; done
--keep leaves instances running; --attach reuses kept ones. --out defaults to <scratch>/<label>.json.
compare prints the medians of two reports per tab count, profile count, gesture and metric.`;

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 1);
}
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 1) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

if (argv[0] === "compare") {
  compare(argv[1], argv[2]);
  process.exit(0);
}
if (argv[0] !== "run") {
  console.log(HELP);
  process.exit(1);
}

const appArg = flag("app");
const scratch = resolve(flag("scratch", "/tmp/ardia-perf/sidebar"));
const label = flag("label", "run");
const bundle = flag("bundle");
const tabCounts = flag("tabs", "50,150,300").split(",").map(Number);
const profileCounts = flag("profiles", "1,2").split(",").map(Number);
const reps = Number(flag("reps", "5"));
const gestures = flag("gestures", "pan,pan-up,wheel,wheel-up").split(",");
const pointerOver = flag("pointer", "over") !== "away";
const tabLayout = flag("layout", "sidebar") === "top" ? "top" : "sidebar";
const TAB_ACTIONS = new Set(["open", "close", "close-run"]);
const CLOSE_RUN_GAP_MS = 120;
const inProcess = flag("post", "app") === "app";
const basePort = Number(flag("port", "9631"));
const keep = has("keep");
const reuse = has("attach");
const append = has("append");
const outFile = resolve(flag("out", join(scratch, `${label}.json`)));
const toolDir = join(scratch, "tools");
const WINDOW = { x: 60, y: 60, w: 1280, h: 860 };
const SECOND_PROFILE_TABS = 40;
const TAIL_MS = 700;

function acperfBin() {
  const bin = join(toolDir, "acperf");
  const src = join(here, "acperf.swift");
  if (!existsSync(bin) || readFileSync(src, "utf8") !== (existsSync(bin + ".src") ? readFileSync(bin + ".src", "utf8") : "")) {
    mkdirSync(toolDir, { recursive: true });
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    writeFileSync(bin + ".src", readFileSync(src, "utf8"));
  }
  return bin;
}
const acperf = (...args) => {
  const r = spawnSync(acperfBin(), args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`acperf ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const cpuMs = (pid) => JSON.parse(acperf("rusage", String(pid)).split("\n")[0]).cpuNs / 1e6;

function windowOf(pid) {
  const all = JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e",
    `ObjC.import("CoreGraphics"); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))
     .filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowIsOnscreen && w.kCGWindowBounds.Width >= 600).map((w) => ({ id: w.kCGWindowNumber, b: w.kCGWindowBounds })))`], { timeout: 20000 }).toString());
  return all.sort((a, b) => b.b.Width * b.b.Height - a.b.Width * a.b.Height)[0] ?? null;
}

async function shownWindowOf(pid, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const found = windowOf(pid);
    if (found) return found;
  }
  throw new Error(`no on-screen window for pid ${pid}`);
}

function serve() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const name = path.split("/").pop() || "home";
    if (path.startsWith("/slow/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.write(`<title>Slow ${name}</title><p>loading forever`);
      return;
    }
    const audio = path.startsWith("/audio/")
      ? `<script>addEventListener("load",()=>{const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.001;o.connect(g).connect(c.destination);o.start();});</script>`
      : "";
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<!doctype html><title>Page ${name}</title>${audio}<body style="font:15px -apple-system;margin:40px">${name}</body>`);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function servePackager(file) {
  const bytes = readFileSync(file);
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/status") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("packager-status:running");
    }
    if (path.endsWith(".bundle")) {
      res.writeHead(200, { "content-type": "application/javascript", "content-length": bytes.length });
      return res.end(bytes);
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => socket.destroy());
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function fixture(origin, count, profiles) {
  const tabs = [];
  const groups = [];
  let n = 0;
  const tab = (profileId, extra = {}) => {
    const id = `${profileId === "default" ? "t" : "w"}${++n}`;
    const t = { id, profileId, url: `${origin}/p/${id}`, title: `Page ${id} about something`, createdAt: n, lastActiveAt: n, ...extra };
    if (t.pinned) t.pinnedUrl = t.url;
    tabs.push(t);
    return id;
  };
  const many = (profileId, k, extra = () => ({})) => Array.from({ length: k }, (_, i) => tab(profileId, extra(i)));
  const group = (profileId, name, ids, collapsed) => {
    groups.push({ id: `g${groups.length + 1}`, windowId: "w1", profileId, name, icon: null, color: "blue", collapsed, pinned: false, tabIds: ids, createdAt: 1 });
    return ids;
  };
  const special = { 3: { url: `${origin}/audio/a3`, muted: true }, 9: { url: `${origin}/audio/a9`, muted: true }, 6: { url: `${origin}/slow/s6` }, 12: { url: `${origin}/slow/s12` } };
  const personal = [
    ...many("default", 6, () => ({ pinned: true })),
    ...many("default", 3, () => ({ pinned: true, pinnedAsRow: true })),
    ...group("default", "Reading", many("default", 5), false),
    ...group("default", "Errands", many("default", 4), true),
  ];
  personal.push(...many("default", Math.max(0, count - personal.length), (i) => special[i] ?? {}));
  const work = profiles > 1 ? [...many("work", 2, () => ({ pinned: true })), ...many("work", SECOND_PROFILE_TABS - 2)] : [];
  const loose = personal.slice(18);
  const s = session({
    profiles: profiles > 1 ? ["Personal", "Work"] : ["Personal"],
    windows: [{ id: "w1", frame: [WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h], sidebarOpen: true }],
    tabs: tabs.map((t) => ({ ...t, windowId: "w1" })),
    groups,
    settings: { tabLayout, ...(gestures.some((g) => TAB_ACTIONS.has(g)) ? { newTabPosition: "nextToCurrent" } : {}), searchSuggestions: false, warnBeforeClosingLastTab: false, warnBeforeClosingWindow: false },
  });
  s.windows[0].tabIds = [...personal, ...work];
  s.windows[0].activeTabIds = { default: loose[0], ...(work.length ? { work: work[3] } : {}) };
  return { session: s, warm: [loose[3], loose[9], loose[6], loose[12]].filter(Boolean), first: loose[0] };
}

const HELPERS = `
  const st = () => ac.store.getState();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const w = st().windowOrder[0];
`;

async function prepare(inst, fx, pointer) {
  await inst.eval(`${HELPERS}
    st().updateSettings({ tabLayout: ${JSON.stringify(tabLayout)} });
    const warm = ${JSON.stringify(fx.warm)};
    let chain = Promise.resolve();
    for (const id of warm) chain = chain.then(() => { st().activate(id); return wait(700); });
    return chain.then(() => { st().activate(${JSON.stringify(fx.first)}); return wait(1500); }).then(() => ({ layout: st().settings.tabLayout, tabs: st().windows[w].tabIds.length }));`, { timeout: 60000 });
  await inst.eval(`${HELPERS} return Promise.resolve().then(() => ac.shell.devSetPointer(w, ${JSON.stringify(pointer)})).catch(() => false);`);
}

async function readProbe(inst, reset) {
  return inst.eval(`
    const P = globalThis.acPerf;
    if (!P) throw new Error("no perf probe: the data dir needs a perf-probe file");
    const s = P.read();
    ${reset ? "P.reset();" : ""}
    const sum = (c) => Object.values(c || {}).reduce((a, b) => a + b, 0);
    const pick = (c, n) => Object.fromEntries(Object.entries(c || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    const tasksOf = (re) => Object.entries(s.tasks || {}).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
    const msOf = (re) => Object.entries(s.taskMs || {}).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
    return {
      commits: s.commits, renders: sum(s.renders), hostUpdates: s.hostUpdates, storeUpdates: sum(s.storeUpdates),
      scrollEvents: tasksOf(/scroll/i), scrollMs: msOf(/scroll/i), hoverEvents: tasksOf(/mouse(Enter|Leave)/i), hoverMs: msOf(/mouse(Enter|Leave)/i),
      tasks: sum(s.tasks), taskMs: sum(s.taskMs), commitMs: s.commitMs,
      tasksBy: pick(s.tasks, 8), rendersBy: pick(s.renders, 12), commitTasks: pick(s.commitTasks, 8), mountsBy: pick(s.mounts, 8), storeKeys: pick(s.storeKeys, 6),
    };`);
}

class Frames {
  constructor(data) {
    this.data = data;
    this.file = join(data, "bench-frames.jsonl");
    this.seq = 0;
  }
  records() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }
  busy(from, to) {
    const out = { m: 0, j: 0, mMax: 0, jMax: 0, mOver: 0, mLong: [], layoutMs: 0, frames: 0, maxGap: 0, mainCpu: null, jsCpu: null, moving: null, lateMoving: null, movingMaxGap: null };
    const records = this.records();
    const periods = records.filter((r) => r.k === "f" && r.ts >= from && r.ts < to && r.tgt > r.ts).map((r) => r.tgt - r.ts).sort((x, y) => x - y);
    const lateAfter = 1.5 * (periods.length ? periods[periods.length >> 1] : 1000 / 120);
    const before = records.filter((r) => r.k === "y" && r.ts < from).at(-1);
    const offsets = records.filter((r) => r.k === "y" && r.ts >= from && r.ts < to);
    if (offsets.length && before) offsets.unshift(before);
    if (offsets.length) Object.assign(out, { moving: 0, lateMoving: 0, movingMaxGap: 0 });
    for (let i = 1; i < offsets.length; i++) {
      if (Math.abs(offsets[i].y - offsets[i - 1].y) < 0.5) continue;
      const gap = offsets[i].ts - offsets[i - 1].ts;
      out.moving++;
      out.movingMaxGap = Math.max(out.movingMaxGap, gap);
      if (gap > lateAfter) out.lateMoving++;
    }
    const wholeIterations = records.some((r) => r.k === "i");
    let last = null;
    let first = null;
    for (const r of records) {
      if (r.k === "i" && r.th === "m" && r.a < to && r.a + r.d > from) {
        out.mMax = Math.max(out.mMax, r.d);
        if (r.d > 8.3) {
          out.mOver++;
          out.mLong.push([Math.round(r.a - from), Math.round(r.d * 10) / 10]);
        }
      }
      if (r.k === "f" && r.ts >= from && r.ts < to) {
        first ??= r;
        if (r.mc >= 0 && first.mc >= 0) out.mainCpu = r.mc - first.mc;
        if (r.jc >= 0 && first.jc >= 0) out.jsCpu = r.jc - first.jc;
        out.frames++;
        if (last !== null) out.maxGap = Math.max(out.maxGap, r.ts - last);
        last = r.ts;
      }
      if (r.k === "r" && r.a >= from && r.a < to) {
        out[r.th] += r.d;
        if (r.th === "j" || !wholeIterations) out[`${r.th}Max`] = Math.max(out[`${r.th}Max`], r.d);
        if (r.th === "m" && !wholeIterations && r.d > 8.3) {
          out.mOver++;
          out.mLong.push([Math.round(r.a - from), Math.round(r.d * 10) / 10]);
        }
      } else if (r.k === "l" && r.a >= from && r.a < to) out.layoutMs += r.d;
    }
    return out;
  }
  async op(op, args = {}, timeout = 5000) {
    const id = `c${++this.seq}-${Date.now()}`;
    writeFileSync(join(this.data, "bench-frames-cmd.json"), JSON.stringify({ id, op, ...args }));
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(10)) {
      try {
        const r = JSON.parse(readFileSync(join(this.data, "bench-frames-result.json"), "utf8"));
        if (r.id === id) return r.ok ? r : null;
      } catch {}
    }
    return null;
  }
  counters() {
    return this.op("counters");
  }
  async scrollY(y) {
    const r = await this.op("scrollpos", y === undefined ? {} : { y });
    return r ? r.y : null;
  }
}

let opened = 0;
const openBeside = (origin) => `${HELPERS} const id = st().newTab(w, { url: "${origin}/p/fresh${++opened}", newTabCommand: true }); (globalThis.__benchOpened ??= []).push(id); return id;`;
const closeOpened = `${HELPERS} const id = (globalThis.__benchOpened ??= []).pop(); if (id && st().tabs[id]) st().closeTab(id); return id ?? null;`;

async function tabAction(inst, frames, name, origin) {
  if (name === "close-run") {
    for (let i = 0; i < 3; i++) await inst.eval(openBeside(origin));
    await sleep(900);
  } else if (name === "close" && !(await inst.eval(`return (globalThis.__benchOpened ?? []).length;`))) {
    await inst.eval(openBeside(origin));
    await sleep(900);
  }
  await sleep(400);
  await readProbe(inst, true);
  const c0 = await frames.counters();
  const cpu0 = cpuMs(inst.pid);
  const t0 = Date.now();
  if (name === "open") await inst.eval(openBeside(origin));
  else if (name === "close") await inst.eval(closeOpened);
  else await inst.eval(`${HELPERS} const ids = (globalThis.__benchOpened ??= []).splice(-3).reverse(); let chain = Promise.resolve(); for (const id of ids) chain = chain.then(() => { if (st().tabs[id]) st().closeTab(id); return wait(${CLOSE_RUN_GAP_MS}); }); return chain.then(() => ids.length);`, { timeout: 10000 });
  await sleep(TAIL_MS);
  const t1 = Date.now();
  const cpu1 = cpuMs(inst.pid);
  const c1 = await frames.counters();
  const probe = await readProbe(inst, false);
  await sleep(120);
  const busy = frames.busy(t0, t1);
  const counter = (k) => (c0 && c1 ? c1[k] - c0[k] : null);
  return {
    gesture: name, ms: t1 - t0, moved: null,
    frames: busy.frames, maxGapMs: round(busy.maxGap), mainCpuMs: round(busy.mainCpu), jsCpuMs: round(busy.jsCpu), mainBusyMs: round(busy.m), jsBusyMs: round(busy.j), mainMaxMs: round(busy.mMax), jsMaxMs: round(busy.jMax), layoutMs: round(busy.layoutMs),
    cpuMs: round(cpu1 - cpu0), hitTests: counter("rootHitTests"), viewUpdates: counter("viewUpdates"), viewCreates: counter("viewCreates"), layoutPasses: counter("layoutPasses"), uiBlocks: counter("uiBlocks"),
    ...probe,
  };
}

async function gesture(inst, frames, win, name, at, origin) {
  if (TAB_ACTIONS.has(name)) return tabAction(inst, frames, name, origin);
  const reverse = name.endsWith("-up");
  const kind = name.replace(/-up$/, "");
  if (!reverse) await frames.scrollY(0);
  await sleep(reverse ? 300 : 500);
  const y0 = await frames.scrollY();
  await readProbe(inst, true);
  const c0 = await frames.counters();
  const cpu0 = cpuMs(inst.pid);
  const t0 = Date.now();
  const posted = inProcess
    ? await frames.op("gesture", { kind, x: at.x - win.b.X, y: at.y - win.b.Y, rate: 120, reverse }, 10_000)
    : JSON.parse(acperf("postscroll", String(inst.pid), String(win.id), String(at.x), String(at.y), String(win.b.X), String(win.b.Y), kind, "120", ...(reverse ? ["reverse"] : [])));
  if (!posted) throw new Error(`gesture ${name} wasn't posted`);
  await sleep(TAIL_MS);
  const t1 = Date.now();
  const cpu1 = cpuMs(inst.pid);
  const c1 = await frames.counters();
  const probe = await readProbe(inst, false);
  await sleep(120);
  const busy = frames.busy(t0, t1);
  const y1 = await frames.scrollY();
  const counter = (k) => (c0 && c1 ? c1[k] - c0[k] : null);
  return {
    gesture: name, events: posted.events, ms: t1 - t0, moved: y0 === null || y1 === null ? null : Math.round(y1 - y0),
    frames: busy.frames, maxGapMs: round(busy.maxGap), mainCpuMs: round(busy.mainCpu), jsCpuMs: round(busy.jsCpu), mainBusyMs: round(busy.m), jsBusyMs: round(busy.j), mainMaxMs: round(busy.mMax), mainOver: busy.mOver, mainLong: busy.mLong, movingFrames: busy.moving, lateWhileMoving: busy.lateMoving, movingMaxGapMs: round(busy.movingMaxGap), jsMaxMs: round(busy.jMax), layoutMs: round(busy.layoutMs),
    cpuMs: round(cpu1 - cpu0), delivered: counter("scrollEvents"), hitTests: counter("rootHitTests"), viewUpdates: counter("viewUpdates"), viewCreates: counter("viewCreates"), layoutPasses: counter("layoutPasses"), uiBlocks: counter("uiBlocks"),
    ...probe,
  };
}

async function idle(inst, frames) {
  await readProbe(inst, true);
  const cpu0 = cpuMs(inst.pid);
  const t0 = Date.now();
  await sleep(2200);
  const t1 = Date.now();
  const cpu1 = cpuMs(inst.pid);
  const probe = await readProbe(inst, false);
  await sleep(120);
  const busy = frames.busy(t0, t1);
  return { gesture: "idle", ms: t1 - t0, mainCpuMs: round(busy.mainCpu), jsCpuMs: round(busy.jsCpu), mainBusyMs: round(busy.m), jsBusyMs: round(busy.j), cpuMs: round(cpu1 - cpu0), ...probe };
}

async function run() {
  if (!appArg) throw new Error("--app is required");
  mkdirSync(scratch, { recursive: true });
  const base = join(scratch, label);
  mkdirSync(base, { recursive: true });
  const app = prepareApp(appArg, join(base, "app"), { entitlements: INJECTION_ENTITLEMENTS });
  const packager = bundle ? await servePackager(resolve(bundle)) : null;
  const lib = framesLibrary((mkdirSync(toolDir, { recursive: true }), toolDir), here);
  const report = append && existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : { label, app: resolve(appArg), bundle: bundle ? resolve(bundle) : "metro", pointer: pointerOver ? "over" : "away", runs: [] };
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let port = basePort;
  try {
    for (const tabs of tabCounts)
      for (const profiles of profileCounts) {
        const key = `t${tabs}p${profiles}`;
        const data = join(base, key, "data");
        const fx = fixture(origin, tabs, profiles);
        let inst;
        if (reuse) inst = attach(data);
        else
          inst = await launch(app, {
            data, fresh: true, port: port++, session: fx.session, onboarded: true, js: packager ? `127.0.0.1:${packager.address().port}` : "pinned",
            files: { "perf-probe": "" }, env: { AC_BENCH_FRAMES: "1", DYLD_INSERT_LIBRARIES: lib },
          });
        try {
          const win = await shownWindowOf(inst.pid);
          const pointer = pointerOver ? { x: 130, y: Math.round(win.b.Height / 2) } : { x: Math.round(win.b.Width * 0.7), y: Math.round(win.b.Height / 2) };
          if (!reuse) {
            await sleep(3000);
            await prepare(inst, fx, pointer);
          }
          const frames = new Frames(data);
          const at = { x: win.b.X + 130, y: win.b.Y + Math.round(win.b.Height / 2) };
          const rows = [await idle(inst, frames)];
          for (let r = 0; r < reps; r++)
            for (const g of gestures) {
              const row = await gesture(inst, frames, win, g, at, origin);
              if (!TAB_ACTIONS.has(g) && !(Math.abs(row.moved ?? 0) >= 50)) console.log(`WARNING: ${key} ${g} moved ${row.moved} pt: the list didn't scroll, so this row measures nothing`);
              rows.push(row);
              console.log(`${label} ${key} #${r + 1} ${g.padEnd(11)} moved ${String(row.moved).padStart(5)} (${row.delivered} ev)  gap ${row.maxGapMs}  frames ${row.frames}  longest ${row.mainMaxMs}  over ${row.mainOver}  late ${row.lateWhileMoving}/${row.movingFrames} moving  mainCpu ${row.mainCpuMs}  jsCpu ${row.jsCpuMs}  main ${String(row.mainBusyMs).padStart(6)} ms  js ${String(row.jsBusyMs).padStart(6)} ms  cpu ${String(row.cpuMs).padStart(6)} ms  commits ${row.commits}  renders ${row.renders}  scrollEv ${row.scrollEvents}  hoverEv ${row.hoverEvents}  viewUpd ${row.viewUpdates}  layouts ${row.layoutPasses}`);
            }
          console.log(`${label} ${key} idle 2.2 s: main ${rows[0].mainBusyMs} ms  js ${rows[0].jsBusyMs} ms  cpu ${rows[0].cpuMs} ms`);
          report.runs.push({ key, tabs, profiles, at: new Date().toISOString(), rows });
        } finally {
          if (!keep) await inst.quit().catch(() => {});
        }
      }
  } finally {
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`results: ${outFile}`);
    server.close();
    packager?.close();
  }
}

function compare(a, b) {
  const sides = [a, b].map((f) => JSON.parse(readFileSync(f, "utf8")));
  const metrics = ["maxGapMs", "mainMaxMs", "frames", "mainOver", "lateWhileMoving", "movingMaxGapMs", "movingFrames", "hitTests", "mainCpuMs", "jsCpuMs", "mainBusyMs", "jsBusyMs", "cpuMs", "commits", "renders", "scrollEvents", "hoverEvents", "viewUpdates", "layoutPasses", "moved"];
  const group = (side) => {
    const out = new Map();
    for (const run of side.runs)
      for (const row of run.rows) {
        const k = `${run.key} ${row.gesture}`;
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(row);
      }
    return out;
  };
  const [ga, gb] = sides.map(group);
  console.log(`${sides[0].label} → ${sides[1].label}: median (n)`);
  console.log(["case".padEnd(22), ...metrics.map((m) => m.padStart(20))].join(""));
  for (const [k, rowsA] of ga) {
    const rowsB = gb.get(k) ?? [];
    const cell = (m) => {
      const x = median(rowsA.map((r) => r[m]));
      const y = median(rowsB.map((r) => r[m]));
      return `${round(x)}→${round(y)}`.padStart(20);
    };
    console.log([`${k} (${rowsA.length}/${rowsB.length})`.padEnd(22), ...metrics.map(cell)].join(""));
  }
}

run().catch((e) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
