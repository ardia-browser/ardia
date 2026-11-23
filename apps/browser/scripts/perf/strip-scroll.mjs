#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_ENTITLEMENTS, prepareApp } from "../../../../scripts/lib/app-copy.mjs";
import { launch, session, sleep } from "../../../../scripts/lib/instance.mjs";
import { framesLibrary } from "./frames-phase.mjs";
import { medianOrNull as median } from "./median.mjs";

const HELP = `Top tab strip scroll cost: what a two-finger horizontal pan (and a wheel) over the top strip costs the main thread,
the JS thread and the process, with the React work it caused, in hidden instances of one app with one or more JS bundles.

  node apps/browser/scripts/perf/strip-scroll.mjs run --app <Ardia.app> --side <label>=<main.jsbundle> [--side …] --out <dir>
        [--tabs 25,80] [--profiles 1,2] [--reps 5] [--cases mid,back,end,start,leave,arrive,wheel,idle] [--width 1360] [--port 9611]
        [--data <dir>] [--driver inproc|acperf] [--check] [--keep]
  node apps/browser/scripts/perf/strip-scroll.mjs compare <results.json>

Each side is a clone of --app with that bundle (prepareApp, re-signed so acframes.m and acstrip.m load). For every tabs ×
profiles pair, one instance per side (data in --data/<tabs>t<profiles>p-<label>, default <out>/data): tabLayout "top",
3 pinned tiles, the given number of tabs from a local server with a group of 4 among them, the middle tab selected, and
with 2 profiles a second profile of 10 tabs. Then --reps rounds; in each round every case runs once on every side, the
side order alternating round by round, one gesture at a time.

Cases (offsets are the strip's scroll offset, set in-process before the gesture; max = content − viewport):
  mid    from 0.2 × max, a two-finger pan toward the end: acperf's trackpad deltas (0.3 s of fingers, then the momentum
         tail, 181 events at 120/s), sent as precise scroll events without phases
  back   from 0.8 × max, the same toward the start
  end    from max, toward the end (the strip can't scroll further)
  start  from 0, toward the start
  leave  from 0, toward the end (the strip leaves its start: the page drops its start inset)
  arrive from 0.15 × max, toward the start, past it (the page takes its start inset back)
  wheel  from 0.3 × max, 12 wheel notches 90 ms apart, horizontal
  phased from 0.2 × max, the same pan with its gesture and momentum phases (the profile swipe's routing sees a gesture;
         an in-process phased gesture doesn't move an NSScrollView, so this case measures the routing, not a scroll)
  idle   no input for as long as a pan (the floor)
--driver acperf (screen unlocked only) posts real gestures with acperf postscroll instead: the pans as trackpad-x, with their
gesture and momentum phases, so AppKit's responsive scrolling and the profile swipe's routing run as they do for a user.
By default (--driver inproc) the gestures are made in the app by acstrip.m (CGEvent → NSEvent → NSApp sendEvent:, timed on the main queue), because
CGEventPostToPid delivers nothing to a hidden instance while the screen is locked. The pointer is the middle of the strip
at its vertical centre. The driver's own main-thread cost is in every case, idle included.

Per gesture, from just before the first event to 500 ms after the last:
  mainMs, jsMs        CPU time of the main thread and of React Native's JS thread (acstrip.m, thread_info)
  mainBusy, jsBusy    their run-loop busy time (acframes.m)
  mainLongest, jsLongest   the longest run-loop iteration that started in the window (over 8.3 ms costs a 120 Hz frame)
  procMs              the app process's CPU time (acperf rusage)
  layout, mounts, viewUpdates   RCTUIManager layout passes, mount batches with work, updateView calls (acframes.m)
  commits, renders, hostUpdates, tasks, taskMs   React commits, component renders, host updates, native→JS tasks and
                      their JS time (the perf probe)
  moved               how far the strip scrolled
  held                1 when a pan moved the strip its own way by 0.6 to 1 times the room it had (the deltas it posted,
                      up to the strip's end; AppKit applies about 0.75 of them), 0 when something scrolled the strip
                      back or on by itself (a reveal or a clamp during the scroll); --check exits 1 when any pan has 0
results.json holds every gesture; compare prints medians per tabs × profiles × case, side by side.`;

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 1);
}
const command = argv[0];
const flags = {};
const multi = { side: [] };
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--keep" || a === "--check") flags[a.slice(2)] = true;
  else if (a.startsWith("--")) {
    const k = a.slice(2);
    if (k in multi) multi[k].push(argv[++i]);
    else flags[k] = argv[++i];
  } else positional.push(a);
}

const round1 = (x) => (x === null || x === undefined ? x : Math.round(x * 10) / 10);


function toolDirOf(out) {
  const dir = join(out, "tools");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stripLibrary(toolDir) {
  const lib = join(toolDir, "acstrip.dylib");
  const src = join(here, "acstrip.m");
  const stamp = `${lib}.src`;
  if (!existsSync(lib) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== readFileSync(src, "utf8")) {
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", "-framework", "AppKit", "-framework", "QuartzCore", "-arch", "arm64", src, "-o", lib], { stdio: "inherit" });
    execFileSync("codesign", ["--force", "--sign", "-", lib]);
    writeFileSync(stamp, readFileSync(src, "utf8"));
  }
  return lib;
}

function acperfBinary(toolDir) {
  const bin = join(toolDir, "acperf");
  const src = join(here, "acperf.swift");
  const stamp = `${bin}.src`;
  if (!existsSync(bin) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== readFileSync(src, "utf8")) {
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    writeFileSync(stamp, readFileSync(src, "utf8"));
  }
  return bin;
}

function startServer() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("/").filter(Boolean).join(" ") || "home");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${name}</title><body style="font:14px sans-serif">${name}</body>`);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function seed(tabs, profiles, port, width) {
  const names = ["Personal", "Work"].slice(0, profiles);
  const page = (pid, name) => `http://127.0.0.1:${port}/${pid}/${name}`;
  const pins = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, profileId: "default", pinned: true, pin: { as: "tile" }, url: page("default", `pin${i}`), title: `Pinned ${i}`, lastActiveAt: 1 }));
  const own = Array.from({ length: tabs }, (_, i) => ({ id: `t${i}`, profileId: "default", url: page("default", `tab${i}`), title: `Tab ${i} ${"wide title ".repeat(i % 3)}`.trim(), lastActiveAt: 2 + i }));
  const other = profiles > 1 ? Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, profileId: "work", url: page("work", `tab${i}`), title: `Work ${i}`, lastActiveAt: 2 + i })) : [];
  const all = [...pins, ...own, ...other];
  const active = `t${Math.floor(tabs / 2)}`;
  const s = session({
    profiles: names,
    windows: [{ id: "w1", frame: [40, 60, width, 820], sidebarOpen: true, tabLayout: "top" }],
    tabs: all,
    groups: [{ id: "g1", windowId: "w1", profileId: "default", name: "Group", icon: null, color: "blue", collapsed: false, pinned: false, tabIds: ["t5", "t6", "t7", "t8"], createdAt: 1 }],
    settings: { tabLayout: "top" },
  });
  s.windows[0].tabIds = all.map((t) => t.id);
  s.windows[0].tabLayout = "top";
  s.windows[0].activeTabIds = { default: active, ...(profiles > 1 ? { work: "w0" } : {}) };
  return s;
}

class Rig {
  constructor(label, inst, acperf) {
    this.label = label;
    this.inst = inst;
    this.acperf = acperf;
    this.seq = 0;
    this.frames = join(inst.data, "bench-frames.jsonl");
  }
  async cmd(file, result, body, timeout = 5000) {
    const id = `${this.label}-${Date.now()}-${++this.seq}`;
    writeFileSync(join(this.inst.data, file), JSON.stringify({ ...body, id }));
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(5)) {
      try {
        const r = JSON.parse(readFileSync(join(this.inst.data, result), "utf8"));
        if (r.id === id) return r;
      } catch {}
    }
    throw new Error(`${this.label}: ${body.op} timed out`);
  }
  strip(body, timeout) {
    return this.cmd("bench-strip-cmd.json", "bench-strip-result.json", body, timeout);
  }
  counters() {
    return this.cmd("bench-frames-cmd.json", "bench-frames-result.json", { op: "counters" });
  }
  rusage() {
    const r = spawnSync(this.acperf, ["rusage", String(this.inst.pid)], { encoding: "utf8", timeout: 10000 });
    return JSON.parse(r.stdout.trim().split("\n")[0]).cpuNs / 1e6;
  }
  async scroller() {
    const info = await this.strip({ op: "info" });
    const win = info.windows[0];
    if (!win) throw new Error(`${this.label}: no window`);
    const left = win.rect.x;
    const candidates = info.scrollers.filter((s) => s.shown && s.window === win.number && s.rect.x >= left - 1 && s.rect.x < left + win.rect.w / 2 && s.rect.y - win.rect.y >= 0 && s.rect.y - win.rect.y < 60);
    candidates.sort((a, b) => a.rect.x - b.rect.x);
    if (!candidates.length) throw new Error(`${this.label}: no strip scroller in ${JSON.stringify(info)}`);
    return { win, s: candidates[0] };
  }
  busy(t0, t1) {
    const text = existsSync(this.frames) ? readFileSync(this.frames, "utf8") : "";
    const sum = { m: 0, j: 0 };
    const longest = { m: 0, j: 0 };
    for (const line of text.split("\n")) {
      if (!line.startsWith('{"k":"r"')) continue;
      const r = JSON.parse(line);
      const a = Math.max(r.a, t0);
      const b = Math.min(r.a + r.d, t1);
      if (b > a) sum[r.th] += b - a;
      if (r.a >= t0 && r.a < t1) longest[r.th] = Math.max(longest[r.th], r.d);
    }
    return { mainBusy: sum.m, jsBusy: sum.j, mainLongest: longest.m, jsLongest: longest.j };
  }
}

const PROBE_READ = `
  const P = globalThis.acPerf;
  if (!P) throw new Error("no perf probe");
  const st = P.read();
  const sum = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  const top = (c, n) => Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { commits: st.commits, renders: sum(st.renders), hostUpdates: st.hostUpdates, tasks: sum(st.tasks), taskMs: sum(st.taskMs),
    rendersBy: top(st.renders, 8), tasksBy: top(st.tasks, 6), taskMsBy: top(st.taskMs, 6) };
`;

const CASES = {
  mid: { at: 0.2, gesture: "glide-x" },
  back: { at: 0.8, gesture: "glide-x", reverse: true },
  end: { at: 1, gesture: "glide-x" },
  start: { at: 0, gesture: "glide-x", reverse: true },
  leave: { at: 0, gesture: "glide-x" },
  arrive: { at: 0.15, gesture: "glide-x", reverse: true },
  wheel: { at: 0.3, gesture: "wheel-x" },
  phased: { at: 0.2, gesture: "trackpad-x" },
  idle: { idle: 1600 },
};

let driver = "inproc";

const landed = (moved, direction, room) => (moved * direction >= 0.6 * room - 2 && moved * direction <= room + 2 ? 1 : 0);

async function measure(rig, name) {
  const c = CASES[name];
  const { win, s } = await rig.scroller();
  const max = Math.max(0, s.doc - s.clip);
  if (!c.idle) await rig.strip({ op: "set", index: s.index, x: max * c.at });
  await sleep(700);
  await rig.inst.eval("globalThis.acPerf.reset(); return true");
  await sleep(250);
  const before = (await rig.scroller()).s;
  const k0 = await rig.counters();
  const p0 = rig.rusage();
  const c0 = await rig.strip({ op: "cpu" });
  const t0 = Date.now();
  let travel = null;
  if (c.idle) await sleep(c.idle);
  else {
    const x = Math.round(s.rect.x - win.rect.x + s.rect.w / 2);
    const y = Math.round(s.rect.y - win.rect.y + s.rect.h / 2);
    if (driver === "acperf") {
      const gesture = c.gesture === "glide-x" ? "trackpad-x" : c.gesture;
      const args = ["postscroll", String(rig.inst.pid), String(win.number), String(Math.round(win.rect.x + x)), String(Math.round(win.rect.y + y)), String(win.rect.x), String(win.rect.y), gesture, "120", ...(c.reverse ? ["reverse"] : [])];
      const r = spawnSync(rig.acperf, args, { encoding: "utf8", timeout: 20000 });
      if (r.status !== 0) throw new Error(`acperf postscroll: ${r.stderr}`);
    } else {
      const r = await rig.strip({ op: "gesture", window: win.number, x, y, gesture: c.gesture, rate: 120, reverse: !!c.reverse }, 10000);
      if (!r.ok) throw new Error(`${rig.label}: gesture failed: ${JSON.stringify(r)}`);
      if (c.gesture === "glide-x") travel = r.travel;
    }
  }
  await sleep(500);
  const c1 = await rig.strip({ op: "cpu" });
  const t1 = Date.now();
  const p1 = rig.rusage();
  const k1 = await rig.counters();
  const probe = await rig.inst.eval(PROBE_READ);
  await sleep(120);
  const after = (await rig.scroller()).s;
  return {
    mainMs: c1.main - c0.main,
    jsMs: c1.js - c0.js,
    ...rig.busy(t0, t1),
    procMs: p1 - p0,
    layout: k1.layoutPasses - k0.layoutPasses,
    mounts: k1.mountBatches - k0.mountBatches,
    viewUpdates: k1.viewUpdates - k0.viewUpdates,
    ...probe,
    moved: Math.abs(after.offset - before.offset),
    expected: travel === null ? null : Math.min(travel, c.reverse ? before.offset : max - before.offset),
    held: travel === null ? null : landed(after.offset - before.offset, c.reverse ? -1 : 1, Math.min(travel, c.reverse ? before.offset : max - before.offset)),
    from: before.offset,
    max,
    ms: t1 - t0,
  };
}

async function run() {
  const app = flags.app && resolve(flags.app);
  if (!app || !multi.side.length || !flags.out) {
    console.error(HELP);
    process.exit(1);
  }
  const out = resolve(flags.out);
  driver = flags.driver ?? "inproc";
  if (!["inproc", "acperf"].includes(driver)) throw new Error(`--driver is inproc or acperf, not ${driver}`);
  const dataRoot = resolve(flags.data ?? join(out, "data"));
  mkdirSync(out, { recursive: true });
  const toolDir = toolDirOf(out);
  const acperf = acperfBinary(toolDir);
  const dyld = [framesLibrary(toolDir, here), stripLibrary(toolDir)].join(":");
  const sides = multi.side.map((spec) => {
    const [label, bundle] = spec.split("=");
    return { label, bundle: resolve(bundle) };
  });
  if (driver === "acperf" && JSON.parse(spawnSync(acperf, ["display"], { encoding: "utf8" }).stdout).locked)
    throw new Error("--driver acperf needs an unlocked screen: CGEventPostToPid delivers nothing to a hidden instance while it is locked");
  for (const side of sides) side.app = prepareApp(app, join(out, "apps", side.label), { bundle: side.bundle, entitlements: INJECTION_ENTITLEMENTS });
  const tabsList = (flags.tabs ?? "25,80").split(",").map(Number);
  const profilesList = (flags.profiles ?? "1,2").split(",").map(Number);
  const cases = (flags.cases ?? "mid,back,end,start,leave,arrive,wheel,idle").split(",");
  const reps = Number(flags.reps ?? 5);
  const width = Number(flags.width ?? 1360);
  let port = Number(flags.port ?? 9611);
  const server = await startServer();
  const resultsFile = join(out, "results.json");
  const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : { app, rows: [] };
  try {
    for (const tabs of tabsList)
      for (const profiles of profilesList) {
        const config = `${tabs}t${profiles}p`;
        const rigs = [];
        try {
          for (const side of sides) {
            const inst = await launch(side.app, {
              data: join(dataRoot, `${config}-${side.label}`),
              fresh: true,
              port: port++,
              js: "none",
              session: seed(tabs, profiles, server.address().port, width),
              onboarded: true,
              files: { "perf-probe": "" },
              env: { AC_BENCH_FRAMES: "1", AC_BENCH_STRIP: "1", DYLD_INSERT_LIBRARIES: dyld },
              ready: { test: "return !!globalThis.acPerf && !!ac.store.getState().windowOrder.length" },
            });
            rigs.push(new Rig(side.label, inst, acperf));
          }
          await sleep(8000);
          for (const rig of rigs) {
            const { s } = await rig.scroller();
            console.log(`${config} ${rig.label}: pid ${rig.inst.pid}, strip viewport ${Math.round(s.clip)} content ${Math.round(s.doc)} (max ${Math.round(s.doc - s.clip)})`);
          }
          for (let rep = 0; rep < reps; rep++)
            for (const name of cases) {
              const order = rep % 2 ? [...rigs].reverse() : rigs;
              for (const rig of order) {
                const r = await measure(rig, name);
                results.rows.push({ config, tabs, profiles, case: name, side: rig.label, rep, ...r });
                console.log(`${config} ${name.padEnd(5)} ${rig.label.padEnd(8)} #${rep} main ${round1(r.mainMs)} js ${round1(r.jsMs)} busy ${round1(r.mainBusy)}/${round1(r.jsBusy)} proc ${round1(r.procMs)} layout ${r.layout} views ${r.viewUpdates} commits ${r.commits} renders ${r.renders} tasks ${r.tasks} moved ${Math.round(r.moved)}`);
                writeFileSync(resultsFile, JSON.stringify(results, null, 2));
              }
            }
        } finally {
          if (!flags.keep) for (const rig of rigs) await rig.inst.quit().catch(() => {});
        }
      }
  } finally {
    server.close();
    writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`results: ${resultsFile}`);
  }
  compare(resultsFile);
  const snapped = results.rows.filter((r) => r.held === 0);
  for (const r of snapped) console.log(`snapped: ${r.config} ${r.case} ${r.side} #${r.rep}: from ${Math.round(r.from)} moved ${Math.round(r.moved)}, the gesture travelled ${Math.round(r.expected)}`);
  if (flags.check && snapped.length) process.exit(1);
}

function compare(file) {
  const { rows } = JSON.parse(readFileSync(resolve(file), "utf8"));
  const sides = [...new Set(rows.map((r) => r.side))];
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.config} ${r.case}`;
    if (!groups.has(key)) groups.set(key, {});
    (groups.get(key)[r.side] ??= []).push(r);
  }
  const shown = ["mainMs", "jsMs", "mainBusy", "mainLongest", "jsBusy", "procMs", "layout", "viewUpdates", "commits", "renders", "tasks", "moved", "held"];
  console.log(`medians; each cell ${sides.join(" → ")}; n per side in brackets`);
  console.log(["case", ...shown].join(" | "));
  for (const [key, bySide] of groups) {
    const n = sides.map((s) => bySide[s]?.length ?? 0).join("/");
    const cells = shown.map((m) => sides.map((s) => round1(median((bySide[s] ?? []).map((r) => r[m])))).join(" → "));
    console.log([`${key} [${n}]`, ...cells].join(" | "));
  }
}

if (command === "compare") compare(positional[0]);
else if (command === "run") await run();
else {
  console.error(`unknown command ${command}\n\n${HELP}`);
  process.exit(1);
}
