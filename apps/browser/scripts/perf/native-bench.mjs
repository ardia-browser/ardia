#!/usr/bin/env node
// Native performance benchmark: launch, idle cost, memory, tab/window latency and background throttling of a
// Release build, driven in hidden instances (ARDIA_BACKGROUND=1, a throwaway ARDIA_DATA_DIR each run).
//
// Gate recipe, what each row means and which rows don't compare across engines: docs/perf/README.md.
//
//   node apps/browser/scripts/perf/native-bench.mjs --app <Ardia.app> --out <dir> [options]
//     --label <name>          name of this set of results (default: the folder two levels above the app, so
//                             dist/0.2.22/export/Ardia.app is "0.2.22")
//     --bundle <file>         Hermes bundle of scripts/perf/bench-entry.js to run (built from the working tree when
//                             omitted). Pass the same file to a before and an after run so only native code differs.
//                             It must match the app's NATIVE_API_VERSION, or every command fails with the skew.
//     --control <app>         a baseline app, run in the same process interleaved run by run with --app (control first
//                             on even runs, candidate first on odd ones), so both see the same machine. Prints control →
//                             candidate; each side's results land in <out>/<its label>/results.json.
//     --control-bundle <file> the control's bundle (default: --app's bundle); --control-label <name> (default as --label)
//     --prepared              --app (and --control) are copies this script already prepared (<out>/<label>/app/
//                             Ardia.app: bundle swapped in, signed for the marker): run them in place, without
//                             building a bundle, copying or signing. `--only prepare` makes those copies and both templates, and exits.
//     --runs <n>              session and windows runs (default 3); --launch-runs <n> cold launches (default 5)
//     --idle <secs>           each idle window (default 60)
//     --launch-settle <secs>  session: the wait after the first page paints, before the 1-tab idle window (default 30)
//     --close-settle <secs>   session: the wait after closing back to 1 tab, before that memory reading (default 30)
//     --template-cache <dir>  where finished templates are kept (default dist/<v>/bench/templates for an app in
//                             dist/<v>/export, else <out>/.templates), keyed by the app's version, build and code signature
//                             hash, its bundled uBO, the bench bundle and the page port. A cached one is checked again
//                             before use, and both sides' startup components must match
//     --template-max-age <h>  a cached template older than this is made again (default 12; 0 never caches): the CRLSet
//                             and uBO's lists move, so an old one would download them inside the runs
//     --only <a,b>            phases (default launch,session,throttle,sample):
//                               launch     cold launches
//                               session    one instance per run with all of: idle, memory, switch, newtab, newwindow
//                               idle, memory, switch, newtab, newwindow
//                                          only those parts of a session run (still with the 20 tabs they're measured
//                                          with; the settling waits only the chosen parts need). Compare runs made
//                                          with the same --only.
//                               newtabkey  J2: a real ⌘T key event into the app → its command bar committed, on screen and
//                                          typeable; a keystroke → its suggestions on screen (one instance per run)
//                               navigate   J4: a real Enter in the command bar with a local test page's URL → the engine
//                                          asked to load, navigation started, committed, first contentful paint; from a new
//                                          tab's bar (⌘T) and from a page's panel (⌘L). Same instance as newtabkey.
//                               frames     the frame rig (frames-phase.mjs, acframes.m): per interaction of the four journeys
//                                          (command bar, tab switch, sidebar collapse/expand/scroll/hover, profile swipe, new
//                                          window) on the big seed, display-link frames over 8.33/16.7 ms, worst frame, main
//                                          and JS thread busy time. --frames-n repetitions (default 8). Needs the display on.
//                               framecounts the same interactions with the JS perf probe on: commits, host updates, layout
//                                          passes, mount batches (counts, no timing; the ratchet's numbers)
//                               profiles   memory kept by profiles no window shows, and the cost of going back to one:
//                                          a session of --profile-count profiles in one window, each opened once, then
//                                          Personal shown for --idle seconds with no DevTools session open, since a
//                                          page being debugged keeps its profile loaded (alone, with its own seed).
//                                          Compare two settings with --setting and --control-setting on the same app
//                               windows    8 new windows per run, alone
//                               throttle   hidden animating tabs' rAF and timer rates
//                               churn      leak check: open and close 10 tabs 5 times
//                               loading    what a page that never finishes loading costs while it's the active tab (the
//                                          toolbar's stop button breathing): --idle seconds with the seed tab loaded,
//                                          then --idle seconds with a new active tab whose response never ends.
//                                          Against an app built before this phase or on another NATIVE_API_VERSION,
//                                          give the control its own bench bundle: in a worktree of that revision run
//                                          `native-bench.mjs --app <that app> --only prepare --out <dir>` and pass
//                                          <dir>/<label>/bundle/main.jsbundle as --control-bundle. A bundle without
//                                          ac.tabLive is checked through the page's document.readyState instead
//                               sample     main-thread `sample`s, idle and while switching and scrolling
//                               prepare    prepare the app copies and both templates, and exit (see --prepared); none
//                                          of it is a timing, so it can run beside the smoke test and the ratchet
//     --env K=V               repeatable: extra environment for every instance (DYLD_INSERT_LIBRARIES is appended to
//                             the marker library). Instances stay muted; don't pass ARDIA_INSTANCE allowAudio.
//     --control-env K=V       repeatable: extra environment for the control's instances only, so one app can be measured
//                             against itself with, say, ARDIA_SWITCHES=freezeWatchOff=on
//     --profile-count <n>     profiles phase: profiles in the session (default 4, at least 2)
//     --profile-visits <n>    profiles phase: how many of the other profiles to open before idling (default: all; 0
//                             leaves them as a launch finds them, to measure what launch loads)
//     --setting K=V           profiles phase and --seed big, repeatable: a setting in the seeded session (the value is
//                             JSON, or a string), such as unloadProfilesAfter=5m; --control-setting K=V the same for
//                             the control, so one app can be measured against itself with a setting changed
//     --frames-n <n>          repetitions of each interaction per run in frames (default 8; framecounts uses at most 3)
//     --frames-only <regex>   frames, framecounts: only the interactions whose name matches (case-insensitive)
//     --frames-sample         frames: `sample` the app over the first repetition of each interaction (<out>/frames-sample/*.txt)
//     --journey-n <n>         iterations of each journey per run in newtabkey and navigate (default 10)
//     --page-port <n>         the test pages' server port (default 9476; when it's busy, any free port, and templates
//                             aren't cached: they restore their page from this port)
//     --seed big              launch, newtabkey and navigate phases: start every launch from seed.mjs's big saved session (200 tabs in two
//                             profiles, 5000 history entries, 1000 bookmarks) instead of one tab, to time what a
//                             long-time user's launch does. Its active tab is the bench's id=seed page, so the launch
//                             rows mean the same; the other 199 tabs point at the bench server's /static?id=p-…
//     --seed-tabs <n>         --seed big: that many tabs instead of 200 (the extra ones are plain tabs in Personal)
//     --fresh-copy            launch phase only: every launch runs from its own APFS clone of the app (same signature,
//                             a new path and inodes), removed after, as the first launch after an install or update
//                             is. Without it only the first launch of a prepared copy is cold; the rest are warm.
//     --trace-startup <cats>  launch phase only: each launch records Chrome's startup trace of those categories
//                             (`--trace-startup`, 4 s, JSON) into <out>/<label>/traces/launch-<i>.json, named in its
//                             result's `trace`; launch-trace.mjs compares two sides'. Tracing slows the launch:
//                             compare traced launches with traced launches only.
//     --hold <secs>           keep each measured instance alive that long before it quits, its pid and data dir logged
//                             (lldb -p <pid>, heap <pid>, vmmap --summary <pid>). Ctrl-C quits it and stops.
//     --port <n>              the instances' CDP port (default 9377). One instance runs at a time.
//     --compare <a.json>      print a before/after table against another run's results.json
//     --report <b.json>       print the table for saved results (with --compare, before/after) without running
//     Environment: BENCH_ALLOW_APP_NAP=1 leaves App Nap on (the control for the App Nap row); BENCH_DEBUG=1 logs switches;
//     BENCH_CMD_TIMEOUT_MS=<ms> how long a command to the app may take to answer (default 30000; raise it for a dry run
//     on a loaded Mac where scripts/agent/cpu-cap pauses the instance. Timings taken meanwhile are invalid).
//
// Results: <out>/<label>/results.json (every sample) and a summary table (median, min–max over runs) on stdout.
// Needs: Node 22+, swiftc (builds scripts/perf/acperf.swift), clang (builds scripts/perf/acmark.m, loaded into the copy
// of the app to mark when a window's content appears), the app signed with an identity in the keychain.
//
// Sections (MARK:)
//   Probes          acperf() runs acperf.swift (rusage, waitwindow, newwindow, quit); markerLibrary() builds acmark.m;
//                   usage(), usageDelta(), footprint(): CPU, wakeups and phys_footprint per process kind
//   Test pages      PAGE_SCRIPT (window.__ac: fcp, frame, visibility, shown), staticPage, animPage, the local server
//   CDP             Cdp: page targets and their window.__ac
//   App instances   prepareBenchApp (scripts/lib/app-copy.mjs: copy, bundle, marker entitlements, re-sign), buildBundle, Instance (hidden `open -g -n`
//                   launch, the bench-cmd.js → bench-result.json channel of bench-channel.js, marks(), quit)
//   Phases          makeTemplate (the seeded data folder each run copies: its instance stays up until uBO's cache is
//                   written and flushed and the component updater's first check is done, then template.json records
//                   both and a template whose sizes are off stops the run; template-cache.mjs keeps it), launchRun,
//                   sessionRun, windowsRun, newWindow, idleWindow, throttled, throttleRun, churnRun, sampleRun
//   Report          native-summary.mjs builds every row below; printTable. gate-verdict.mjs reads rounds pooled
//   Main            options, the candidate and control sides, interleaved()
//
// Rows: the function that measures each, and what it waits on. Launch rows count from just before `open`; command rows
// from Date.now() in the app's JS as the command starts (ac.now()).
//   launch → window shown                   launchRun   acperf waitwindow: the pid's first on-screen window ≥ 300×200
//                                                        with alpha > 0 (CEF builds show it empty, ArdiaCore with content)
//   launch → window shown with its content  launchRun   the later of that and acmark's commit of the Core Animation
//                                                        transaction carrying the first React root's content
//   launch → JS running                     launchRun   bench-boot.json, written as bench-channel.js loads (after the
//                                                        app's index.js and its imports)
//   launch → first page painted             launchRun   the seed tab's first-contentful-paint (PerformanceObserver)
//   launch → first page's first frame       launchRun   the seed tab's first requestAnimationFrame callback
//   idle CPU / idle wakeups/s (…)           sessionRun  idle: idleWindow(), acperf rusage over the process tree --idle
//                                                        secs apart with the channel paused, at 1 tab (--launch-settle
//                                                        secs after the first page paints) and at 20
//   active tab loading: …                   loadingRun  idleWindow() with the seed tab loaded, then with the active tab
//                                                        on /hang (headers and a first chunk, never the end), checked
//                                                        loading before and after (tabLive isLoading, or the page's
//                                                        readyState when the bundle has no ac.tabLive); only runs where
//                                                        the same /hang tab is active and loading at both ends count
//   JS heap / JS allocated (Hermes)         sessionRun  memory: HermesInternal.getInstrumentedStats() right after each
//                                                        footprint: js_heapSize (the GC's capacity, in 4 MB segments) and
//                                                        js_allocatedBytes
//   memory (phys_footprint), …              sessionRun  memory: footprint() of the tree at 1 tab (after the idle
//                                                        window), 10 tabs (+10 s), 20 tabs (+15 s), and closed back to
//                                                        1 (+--close-settle secs); "browser process" rows: that process
//   after an idle minute: command answered  sessionRun  idle: the first command after the 1-tab idle (App Nap check)
//   idle windows: someone used the Mac      sessionRun  idle: acperf input over each idle window: seconds of mouse,
//                                                        trackpad or keyboard input (HIDIdleTime), and of the pointer
//                                                        moving over the instance's window. Nonzero means the idle rows
//                                                        of that run measured the owner's input too
//   samples left out: page couldn't paint   sessionRun  switch/newtab: throttled(), < 5 rAF frames in 250 ms just before
//   tab switch → shown                      sessionRun  switch: ac.actions.switchToTab → the page's visibilitychange to
//                                                        visible + 2 rAFs (16 per run, among 20 tabs)
//   new tab → first paint / first frame     sessionRun  newtab: store newTab → the new page's FCP / first rAF (5 per run)
//   new window → on screen                  newWindow   ac.actions.openWindow → acperf newwindow (2 ms polls; ≥ 300×200,
//                                                        alpha > 0). 3 per session run (newwindow), 8 per windows run
//   new window → on screen with its content newWindow   the later of that and acmark's commit for that window
//   new window → first paint / first frame  newWindow   the window's page's FCP / first rAF
//   profiles loaded / memory, N profiles   profilesRun profiles.loaded and footprint() of the tree 60 s after the last profile
//                                                        was opened and again after --idle seconds on Personal
//   back to a profile → its page shown      profilesRun store switchProfile to the first other profile → its page's
//                                                        visibilitychange + 2 rAFs when the page was kept, its first
//                                                        contentful paint when it had to load again
//   ⌘T → …, keystroke → suggestions         journeyRun  newtabkey: acperf postkeys (CGEventPostToPid into this pid) → the app's field timing
//                                                        (journeys.ts + ArdiaFieldTiming.mm; sharing on in the bench's data folder,
//                                                        every non-local fetch answered by bench-offline.js so nothing is uploaded)
//   Enter → engine asked / started / committed / first contentful paint
//                                           journeyRun  navigate: the same, from a real Enter; also the page's own FCP over CDP
// Also printed: "Hidden tabs" (throttleRun), the browser process after each churn round, main-thread sample summaries.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadavg, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { INJECTION_ENTITLEMENTS, prepareApp } from "../../../../scripts/lib/app-copy.mjs";
import { appEnv, isAlive, launchVariables, mergeLaunchEnv, sleep } from "../../../../scripts/lib/instance.mjs";
import { buildSeed } from "./seed.mjs";
import { waitForUboEngine } from "./ubo-cache.mjs";
import { launchedTree, listenerPid, quitTargets, signalIfSame, stopTree, survivors } from "./processes.mjs";
import { componentsMismatch, componentsState, jointProblems, templateProblems, templateSizes, waitForStartupComponents } from "./template-state.mjs";
import { parseSettings, profileSeed } from "./profile-seed.mjs";
import { writeSwitches } from "./js-bench.mjs";
import { frameTable, framesLibrary, framesRun } from "./frames-phase.mjs";
import { LOADING_FIXTURE, summary } from "./native-summary.mjs";
import { appIdentity, copyCachedTemplate, defaultCacheDir, fileSha256, keyProblems, lookupTemplate, sourceChanged, storePair, TEMPLATE_MAX_AGE_HOURS, templateKey, cachedAgeHours } from "./template-cache.mjs";
import { sideLaunchEnv } from "./launch-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");
const repoRoot = resolve(appRoot, "../..");
const { values: opt } = parseArgs({
  options: {
    app: { type: "string" },
    out: { type: "string", default: join(tmpdir(), "ac-native-bench") },
    label: { type: "string" },
    bundle: { type: "string" },
    runs: { type: "string", default: "3" },
    "launch-runs": { type: "string", default: "5" },
    idle: { type: "string", default: "60" },
    "launch-settle": { type: "string", default: "30" },
    "close-settle": { type: "string", default: "30" },
    "template-cache": { type: "string" },
    "template-max-age": { type: "string", default: String(TEMPLATE_MAX_AGE_HOURS) },
    only: { type: "string", default: "launch,session,throttle,sample" },
    compare: { type: "string" },
    report: { type: "string" },
    port: { type: "string", default: "9377" },
    control: { type: "string" },
    "control-bundle": { type: "string" },
    "control-label": { type: "string" },
    prepared: { type: "boolean" },
    env: { type: "string", multiple: true, default: [] },
    "control-env": { type: "string", multiple: true, default: [] },
    seed: { type: "string" },
    "seed-tabs": { type: "string", default: "200" },
    "profile-count": { type: "string", default: "4" },
    "profile-visits": { type: "string" },
    setting: { type: "string", multiple: true, default: [] },
    "control-setting": { type: "string", multiple: true, default: [] },
    "fresh-copy": { type: "boolean" },
    "trace-startup": { type: "string" },
    "page-port": { type: "string", default: "9476" },
    "journey-n": { type: "string", default: "10" },
    "frames-n": { type: "string", default: "8" },
    "frames-only": { type: "string" },
    "frames-sample": { type: "boolean" },
    hold: { type: "string", default: "0" },
    help: { type: "boolean", short: "h" },
  },
});
if (opt.help) {
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const log = (...a) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a);

const toolDir = join(opt.out, ".tools");
function acperf(...args) {
  const bin = join(toolDir, "acperf");
  const src = join(here, "acperf.swift");
  if (!existsSync(bin) || readFileSync(src, "utf8") !== (existsSync(bin + ".src") ? readFileSync(bin + ".src", "utf8") : "")) {
    mkdirSync(toolDir, { recursive: true });
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    writeFileSync(bin + ".src", readFileSync(src, "utf8"));
  }
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout.trim() };
}

function markerLibrary() {
  const lib = join(toolDir, "acmark.dylib");
  const src = join(here, "acmark.m");
  if (!existsSync(lib) || readFileSync(src, "utf8") !== (existsSync(lib + ".src") ? readFileSync(lib + ".src", "utf8") : "")) {
    mkdirSync(toolDir, { recursive: true });
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", "-framework", "AppKit", "-framework", "QuartzCore", "-arch", "arm64", src, "-o", lib], { stdio: "inherit" });
    execFileSync("codesign", ["--force", "--sign", "-", lib]);
    writeFileSync(lib + ".src", readFileSync(src, "utf8"));
  }
  return lib;
}

function processTree(root) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: +pid, ppid: +ppid, command }));
  const tree = [];
  const walk = (pid) => {
    for (const row of rows) if (row.ppid === pid) tree.push(row), walk(row.pid);
  };
  const self = rows.find((r) => r.pid === root);
  if (!self) return [];
  tree.push(self);
  walk(root);
  return tree.map((r) => ({ pid: r.pid, kind: kindOf(r.command) }));
}

function kindOf(command) {
  const type = command.match(/--type=(\S+)/)?.[1];
  if (!type) return "browser";
  if (type === "utility") return `utility:${command.match(/--utility-sub-type=([\w.]+)/)?.[1]?.split(".")[0] ?? "?"}`;
  if (type === "renderer" && command.includes("--extension-process")) return "extension";
  return type;
}

function usage(root) {
  const procs = processTree(root);
  const byPid = new Map(procs.map((p) => [p.pid, p.kind]));
  const lines = procs.length ? acperf("rusage", ...procs.map((p) => String(p.pid))).out.split("\n").filter(Boolean) : [];
  return lines.map((l) => JSON.parse(l)).map((u) => ({ ...u, kind: byPid.get(u.pid) }));
}

function usageDelta(a, b) {
  const before = new Map(a.map((u) => [u.pid, u]));
  const kinds = {};
  let total = { cpu: 0, wakeups: 0 };
  for (const u of b) {
    const p = before.get(u.pid);
    if (!p) continue;
    const secs = (u.at - p.at) / 1000;
    const cpu = ((u.cpuNs - p.cpuNs) / 1e9 / secs) * 100;
    const wakeups = (u.idleWakeups + u.interruptWakeups - p.idleWakeups - p.interruptWakeups) / secs;
    const k = (kinds[u.kind] ??= { cpu: 0, wakeups: 0, count: 0 });
    k.cpu += cpu;
    k.wakeups += wakeups;
    k.count++;
    total.cpu += cpu;
    total.wakeups += wakeups;
  }
  return { total, kinds };
}

const footprint = (snap) => {
  const kinds = {};
  let total = 0;
  for (const u of snap) {
    kinds[u.kind] = (kinds[u.kind] ?? 0) + u.footprint / 1048576;
    total += u.footprint / 1048576;
  }
  return { totalMB: total, processes: snap.length, kinds };
};


const PAGE_SCRIPT = `
window.__ac = { vis: [[Date.now(), document.visibilityState]], shown: [], fcp: null, frame: null, ticks: 0, raf: 0, fast: 0 };
requestAnimationFrame(() => (__ac.frame = Date.now()));
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) if (e.name === "first-contentful-paint") __ac.fcp = performance.timeOrigin + e.startTime;
}).observe({ type: "paint", buffered: true });
document.addEventListener("visibilitychange", () => {
  const t = Date.now();
  __ac.vis.push([t, document.visibilityState]);
  if (document.visibilityState === "visible")
    requestAnimationFrame(() => requestAnimationFrame(() => __ac.shown.push([t, Date.now()])));
});
setInterval(() => __ac.ticks++, 1000);
`;

function staticPage(id) {
  const paras = Array.from({ length: 120 }, (_, i) =>
    `<p>Paragraph ${i} of page ${id}. The quick brown fox jumps over the lazy dog; pack my box with five dozen liquor jugs. ` +
    `Sphinx of black quartz, judge my vow. <a href="#p${i}">anchor ${i}</a></p>`).join("");
  const boxes = Array.from({ length: 60 }, (_, i) =>
    `<div class=b style="background:hsl(${(i * 37 + Number(id.replace(/\D/g, "") || 0) * 11) % 360} 60% 70%)">${i}</div>`).join("");
  return `<!doctype html><meta charset=utf-8><title>Bench ${id}</title>
<style>body{font:15px/1.5 -apple-system,sans-serif;margin:0;padding:24px 48px;background:#fbfaf8;color:#222}
.g{display:grid;grid-template-columns:repeat(10,1fr);gap:8px;margin:16px 0}.b{height:48px;border-radius:10px;display:grid;place-items:center}
h1{font-size:32px}</style><h1>Bench page ${id}</h1><div class=g>${boxes}</div>${paras}<script>${PAGE_SCRIPT}</script>`;
}

function animPage(id) {
  return `<!doctype html><meta charset=utf-8><title>Anim ${id}</title>
<style>@keyframes s{to{transform:rotate(360deg)}}.s{width:80px;height:80px;background:#c35;animation:s 1s linear infinite;margin:40px}</style>
<h1>Anim ${id}</h1><div class=s></div><script>${PAGE_SCRIPT}
(function f(){ __ac.raf++; requestAnimationFrame(f); })();
setInterval(() => __ac.fast++, 16);</script>`;
}

const hanging = new Set();

function startServer() {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const id = url.searchParams.get("id") ?? "0";
      if (url.pathname === "/hang") {
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return void res.write(`<!doctype html><meta charset=utf-8><title>Loading ${id}</title><script>${PAGE_SCRIPT}</script><h1>Still loading ${id}</h1>`);
      }
      const html = url.pathname === "/anim" ? animPage(id) : url.pathname === "/static" ? staticPage(id) : null;
      if (!html) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
    });
    const wanted = +opt["page-port"];
    server.once("error", (error) => {
      if (error.code !== "EADDRINUSE" || !wanted) throw error;
      log(`page port ${wanted} is busy: serving the test pages on any free port, so templates aren't cached this run`);
      server.listen(0, "127.0.0.1", () => resolveServer(server));
    });
    server.listen(wanted, "127.0.0.1", () => resolveServer(server));
  });
}

class Cdp {
  constructor(port) {
    this.port = port;
    this.sockets = new Map();
    this.seq = 0;
  }
  async targets() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3000) });
      return (await r.json()).filter((t) => t.type === "page");
    } catch {
      return [];
    }
  }
  async socket(target) {
    let s = this.sockets.get(target.id);
    if (s && s.readyState === 1) return s;
    s = new WebSocket(target.webSocketDebuggerUrl);
    s.pending = new Map();
    s.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      s.pending.get(msg.id)?.(msg);
      s.pending.delete(msg.id);
    };
    await new Promise((ok, fail) => ((s.onopen = ok), (s.onerror = fail), setTimeout(fail, 3000)));
    this.sockets.set(target.id, s);
    return s;
  }
  async send(target, method, params = {}, timeout = 4000) {
    const s = await this.socket(target);
    const id = ++this.seq;
    return new Promise((ok) => {
      const timer = setTimeout(() => (s.pending.delete(id), ok(null)), timeout);
      s.pending.set(id, (msg) => (clearTimeout(timer), ok(msg.result ?? null)));
      s.send(JSON.stringify({ id, method, params }));
    });
  }
  async state(target) {
    const r = await this.send(target, "Runtime.evaluate", {
      expression: "JSON.stringify(Object.assign({}, window.__ac, { visibility: document.visibilityState }))",
      returnByValue: true,
    }).catch(() => null);
    try {
      return JSON.parse(r?.result?.value ?? "null");
    } catch {
      return null;
    }
  }
  async find(substring) {
    return (await this.targets()).find((t) => t.url.endsWith(substring) || t.url.includes(substring + "&"));
  }
  close() {
    for (const s of this.sockets.values()) s.close();
    this.sockets.clear();
  }
}

function prepareBenchApp(app, out, bundle) {
  const copy = prepareApp(app, out, { bundle, entitlements: INJECTION_ENTITLEMENTS });
  writeFileSync(join(out, "prepared.json"), JSON.stringify({ app, bundle, source: appIdentity(app), date: new Date().toISOString() }));
  return copy;
}

function checkPrepared(copy) {
  if (copy.startsWith("/Applications/")) throw new Error(`--prepared runs the app in place; ${copy} is the owner's`);
  const granted = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", copy], { encoding: "utf8" }).stdout ?? "";
  if (!granted.includes("<key>com.apple.security.cs.allow-dyld-environment-variables</key>"))
    throw new Error(`${copy} isn't a copy native-bench prepared (run once without --prepared, or with --only prepare)`);
  let from;
  try {
    from = JSON.parse(readFileSync(join(dirname(copy), "prepared.json"), "utf8"));
  } catch {
    return { app: copy, bundle: join(copy, "Contents/Resources/main.jsbundle") };
  }
  const changed = existsSync(from.app) ? sourceChanged(from.source, appIdentity(from.app)) : [];
  if (changed.length) throw new Error(`${copy} was prepared from an older build of ${from.app} (${changed.join("; ")}): run --only prepare again`);
  return from;
}

function buildBundle(out) {
  const js = join(out, "bench.js"), hbc = join(out, "main.jsbundle");
  const node = process.execPath;
  log("bundling scripts/perf/bench-entry.js (production)");
  execFileSync(node, [join(repoRoot, "node_modules/react-native-macos/scripts/bundle.js"), "bundle", "--entry-file", "scripts/perf/bench-entry.js",
    "--platform", "macos", "--dev", "false", "--minify", "false", "--bundle-output", js, "--assets-dest", join(out, "assets"),
    "--config-cmd", `'${node}' '${join(repoRoot, "node_modules/react-native-macos/cli.js")}' config`], { cwd: appRoot, stdio: "inherit" });
  execFileSync(join(appRoot, "macos/Pods/hermes-engine/destroot/bin/hermesc"), ["-emit-binary", "-O", "-out", hbc, js], { stdio: "inherit" });
  return hbc;
}

const live = new Set();

class Instance {
  constructor(side, dataDir) {
    this.side = side;
    this.app = side.app;
    this.dataDir = dataDir;
    this.port = +opt.port;
    this.feed = `${base()}/appcast.xml`;
    this.cdp = new Cdp(this.port);
    this.seq = 0;
    this.env = [];
    this.tracked = new Map();
  }
  track() {
    if (!this.pid || !this.confirmed) return;
    for (const p of launchedTree(this.pid, realpathSync(this.app))) this.tracked.set(p.pid, p);
  }
  async confirmOwnBrowser(timeoutMs = 30_000) {
    let owner = null;
    for (const end = Date.now() + timeoutMs; !owner && Date.now() < end; ) (owner = listenerPid(this.port)) || (await sleep(100));
    if (owner !== this.pid) throw new Error(`pid ${this.pid} isn't this instance's browser: port ${this.port} is held by ${owner ?? "nobody"}`);
    this.confirmed = true;
    this.track();
    if (!this.tracked.has(this.pid)) throw new Error(`pid ${this.pid} isn't running ${realpathSync(this.app)}`);
  }
  async launch() {
    const exe = join(realpathSync(this.app), "Contents/MacOS", execFileSync("defaults", ["read", join(this.app, "Contents/Info.plist"), "CFBundleExecutable"], { encoding: "utf8" }).trim());
    const main = `^${exe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;
    if (spawnSync("pgrep", ["-f", main]).status === 0) throw new Error("a bench instance is still running");
    const { extra, libraries, switches } = sideLaunchEnv(opt.env, opt["control-env"], this.side.role, this.env);
    writeSwitches(this.dataDir, switches);
    const dyld = [markerLibrary(), ...(this.frames ? [framesLibrary(toolDir, here)] : []), ...libraries].join(":");
    this.t0 = Date.now();
    const env = appEnv(this.app, mergeLaunchEnv({
      ARDIA_BACKGROUND: "1", ARDIA_DATA_DIR: this.dataDir, ARDIA_REMOTE_DEBUGGING_PORT: String(this.port),
      ...launchVariables({ instance: { updateFeed: this.feed } }), DYLD_INSERT_LIBRARIES: dyld,
    }, ...extra.map((e) => ({ [e.slice(0, e.indexOf("="))]: e.slice(e.indexOf("=") + 1) }))));
    execFileSync("open", ["-g", "-n", ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), this.app,
      "--args", "--mute-audio", ...(process.env.BENCH_ALLOW_APP_NAP ? [] : ["-NSAppSleepDisabled", "YES"])]);
    for (let i = 0; i < 400 && !this.pid; i++) {
      const r = spawnSync("pgrep", ["-f", main], { encoding: "utf8" });
      if (r.status === 0) this.pid = +r.stdout.trim().split("\n")[0];
      else await sleep(5);
    }
    if (!this.pid) throw new Error("the app didn't start");
    live.add(this);
    const w = acperf("waitwindow", String(this.pid), "60");
    this.windowAt = w.code === 0 ? +w.out : NaN;
    const boot = await this.waitFile("bench-boot.json", 60_000);
    this.jsStart = boot?.jsStart ?? NaN;
    await this.confirmOwnBrowser();
    return this;
  }
  marks() {
    try {
      return readFileSync(join(this.dataDir, "bench-marks.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
  alive() {
    return isAlive(this.pid);
  }
  async waitFile(name, timeout, accept = () => true) {
    const file = join(this.dataDir, name);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (!this.alive()) throw new Error(`the app (pid ${this.pid}) died`);
      try {
        const v = JSON.parse(readFileSync(file, "utf8"));
        if (accept(v)) return v;
      } catch {}
      await sleep(20);
    }
    return null;
  }
  async run(body, timeout = +(process.env.BENCH_CMD_TIMEOUT_MS ?? 30_000)) {
    const id = `b${process.pid}-${++this.seq}-${Date.now()}`;
    writeFileSync(join(this.dataDir, "bench-cmd.js"), `// ${id}\nvar ac = typeof ac === "undefined" ? nn : ac;\n${body}`);
    const r = await this.waitFile("bench-result.json", timeout, (v) => v.id === id);
    if (!r) throw new Error(`no result for: ${body.slice(0, 80)}`);
    if (r.error) throw new Error(`${r.error} in: ${body.slice(0, 80)}`);
    return r.result;
  }
  async pageState(substring, timeout = 20_000, accept = (s) => s) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const t = await this.cdp.find(substring);
      const s = t && (await this.cdp.state(t));
      if (s && accept(s)) return s;
      await sleep(15);
    }
    return null;
  }
  async done() {
    const secs = +opt.hold;
    if (secs > 0 && this.pid && this.alive()) {
      log(`holding ${this.side.label} pid ${this.pid} for ${secs} s (data ${this.dataDir}): lldb -p ${this.pid}, heap ${this.pid}, vmmap --summary ${this.pid}`);
      for (const end = Date.now() + secs * 1000; Date.now() < end && this.alive(); ) await sleep(200);
    }
    await this.quit();
  }
  async quit() {
    this.cdp.close();
    live.delete(this);
    if (!this.pid) return;
    const app = realpathSync(this.app);
    if (!this.confirmed && listenerPid(this.port) === this.pid) this.confirmed = true;
    if (!this.confirmed) log(`not stopping pid ${this.pid}: it never proved to be this instance's browser (port ${this.port})`);
    this.track();
    const browser = this.tracked.get(this.pid);
    if (browser && survivors([browser], app).length) {
      acperf("quit", String(this.pid));
      for (let i = 0; i < 100 && survivors([browser], app).length; i++) await sleep(100);
      signalIfSame(browser, "SIGKILL");
    }
    await stopTree(quitTargets({ tracked: [...this.tracked.values()], confirmed: !!this.confirmed }, app), app);
  }
}

const base = () => `http://127.0.0.1:${server.address().port}`;
let server;

const FOCUSED = `(s.ui.focusOrder?.[0] ?? s.ui.focusedWindowId)`;
const WINDOW = `(() => { const s = ac.store.getState(); const f = ${FOCUSED}; return f && s.windows[f] ? f : s.windowOrder.find((id) => s.windows[id] && (!s.windows[id].kind || s.windows[id].kind === "main")); })()`;

const sideSettings = (side) => parseSettings(side.role === "control" ? opt["control-setting"] : opt.setting);

function writeBigSeed(side) {
  const dir = side.template;
  const version = execFileSync("defaults", ["read", join(side.src, "Contents/Info.plist"), "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
  const files = buildSeed(base(), version, { tabs: +opt["seed-tabs"] });
  delete files["perf-probe"];
  const session = files["session.json"];
  Object.assign(session.settings, sideSettings(side));
  const win = session.windows[0];
  for (const t of session.tabs) {
    const id = t.id === win.activeTabIds.default ? "seed" : `p-${t.id}`;
    t.url = `${base()}/static?id=${id}`;
    if (t.pinnedUrl) t.pinnedUrl = t.url;
  }
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  log(`seeded the big session (${side.label}): ${session.tabs.length} tabs, ${files["history.json"].history.default.length} history entries`);
}

async function makeTemplate(side) {
  const dir = side.template;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (only.has("profiles")) {
    writeFileSync(join(dir, "session.json"), JSON.stringify(profileSeed(base(), +opt["profile-count"], sideSettings(side))));
    writeFileSync(join(dir, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
    return;
  }
  if (opt.seed) return writeBigSeed(side);
  log(`seeding a session (${side.label})`);
  writeFileSync(join(dir, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
  const app = await new Instance(side, dir).launch();
  const waited = {};
  try {
    await app.run(`const w = ${WINDOW}; ac.store.getState().newTab(w, { url: "${base()}/static?id=seed" }); return w;`);
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await app.run(`const s = ac.store.getState(); const w = ${WINDOW};
      const keep = s.windows[w].tabIds.find((id) => s.tabs[id].url.includes("id=seed"));
      for (const id of s.windows[w].tabIds) if (id !== keep) ac.store.getState().closeTab(id);
      for (const id of s.windowOrder) if (id !== w) ac.store.getState().closeWindow(id);
      ac.store.getState().activate(keep); return keep;`);
    await sleep(4000);
    waited.ubo = await waitForUboEngine({ port: +opt.port, dataDir: dir, log });
    waited.components = await waitForStartupComponents({ dataDir: dir, launchedAt: app.t0, log });
  } finally {
    await app.quit();
  }
  for (const f of ["bench-cmd.js", "bench-result.json", "bench-boot.json"]) rmSync(join(dir, f), { force: true });
  const record = { waitedSecs: { ubo: waited.ubo.secs, components: waited.components.secs }, uboSelfies: waited.ubo.selfies, sizes: templateSizes(dir), components: componentsState(dir).components };
  useTemplateRecord(side, record, "made now");
}

const cachedChecks = () => ({ maxAgeHours: +opt["template-max-age"], componentsOf: (dir) => componentsState(dir).components });

function templateCache(side) {
  if (!(+opt["template-max-age"] > 0) || only.has("profiles") || opt.seed) return null;
  if (opt.env.length || opt["control-env"].length) {
    log(`${side.label}: not caching its template (--env or --control-env changes what the template's launch ran with)`);
    return null;
  }
  const key = templateKey({ identity: appIdentity(side.app), bundleSha: fileSha256(join(side.app, "Contents/Resources/main.jsbundle")), pagePort: server.address().port === +opt["page-port"] ? +opt["page-port"] : 0 });
  const problems = keyProblems(key);
  if (problems.length) {
    log(`${side.label}: not caching its template (${problems.join("; ")})`);
    return null;
  }
  return { key, dir: resolve(opt["template-cache"] ?? defaultCacheDir(side.results.meta.preparedFrom?.app ?? side.src, opt.out)) };
}

function useTemplateRecord(side, record, how) {
  side.templateRecord = record;
  writeFileSync(join(side.dir, "template.json"), JSON.stringify(record, null, 2));
  side.results.meta.template = record;
  const problems = templateProblems(record);
  if (problems.length) throw new Error(`${side.label}'s template is off, so its runs would be skewed: ${problems.join("; ")} (${join(side.dir, "template.json")})`);
  const { uboStoreMB, uboBlobsMB } = record.sizes;
  log(`${side.label}'s template (${how}): uBO store ${uboStoreMB.toFixed(1)} MB, blobs ${uboBlobsMB.toFixed(1)} MB; components ${Object.entries(record.components).map(([k, c]) => `${k} ${c.version}`).join(", ")}`);
}

async function makeTemplates() {
  for (const side of sides) side.cache = templateCache(side);
  const found = sides.map((side) => side.cache && lookupTemplate(side.cache.dir, side.cache.key, cachedChecks()));
  const pairs = new Set(found.map((f) => f?.entry?.pair ?? null));
  const cachedJoint = found.every((f) => f?.hit) ? jointProblems(found.map((f) => f.entry.record)) : [];
  if (cachedJoint.length) log(`the cached pair doesn't match (${cachedJoint.join("; ")}): making both again`);
  const usable = found.every((f) => f?.hit) && pairs.size === 1 && !pairs.has(null) && !cachedJoint.length;
  const copied = usable ? sides.map((side, i) => copyCachedTemplate(found[i], side.template, cachedChecks())) : [];
  if (usable && copied.every((c) => c.ok)) {
    for (const [i, side] of sides.entries())
      useTemplateRecord(side, { ...found[i].entry.record, cached: { dir: found[i].dir, made: found[i].entry.made, pair: found[i].entry.pair } },
        `cached ${cachedAgeHours(found[i].entry).toFixed(1)} h ago with the other side's, ${found[i].dir}`);
  } else {
    if (usable) log(`a cached template didn't copy cleanly (${copied.map((c, i) => `${sides[i].label}: ${c.ok ? "ok" : c.problems.join("; ")}`).join("; ")}): making both again`);
    if (sides.some((s) => s.cache)) log(`making ${sides.length > 1 ? "both sides' templates together" : "the template"} (${found.map((f, i) => `${sides[i].label}: ${!f ? "not cached" : !f.hit ? f.problems.join("; ") : "cached, but not made with the other side's"}`).join("; ")})`);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const side of sides) await makeTemplate(side);
      if (!componentsMismatch(sides.map((s) => s.templateRecord).filter(Boolean)).length) break;
      log(`the sides' startup components differ (${componentsMismatch(sides.map((s) => s.templateRecord)).join("; ")}): making both again`);
    }
    const cached = sides.filter((s) => s.cache);
    const stored = storePair(cached.map((s) => ({ cacheDir: s.cache.dir, key: s.cache.key, templateDir: s.template, record: s.templateRecord })), jointProblems(sides.map((s) => s.templateRecord).filter(Boolean)));
    for (const [i, dir] of stored.entries()) log(`${cached[i].label}'s template stored in ${dir}`);
    if (cached.length && !stored.length) log("not caching these templates: the two sides don't match");
  }
  const records = sides.map((s) => s.templateRecord).filter(Boolean);
  const mismatch = jointProblems(records);
  if (mismatch.length) throw new Error(`the two sides' templates don't match: ${mismatch.join("; ")}`);
}

function freshDir(side, name) {
  const dir = join(side.dir, "data", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync("cp", ["-Rc", side.template, dir]);
  return dir;
}

async function launchRun(side, i) {
  const copy = opt["fresh-copy"] ? join(side.dir, "fresh", `app-${i}`) : null;
  if (copy) {
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy, { recursive: true });
    execFileSync("cp", ["-Rc", side.app, join(copy, "Ardia.app")]);
  }
  const app = new Instance(copy ? { ...side, app: join(copy, "Ardia.app") } : side, freshDir(side, `launch-${i}`));
  const traceFile = join(app.dataDir, "startup-trace.json");
  if (opt["trace-startup"]) {
    app.env.push(`ARDIA_INSTANCE=chromiumSwitches=--trace-startup=${opt["trace-startup"]} --trace-startup-file=${traceFile} --trace-startup-duration=4 --trace-startup-format=json`);
  }
  try {
    await app.launch();
    const page = await app.pageState("id=seed", 30_000, (s) => s.fcp);
    const contentMarks = () => {
      const marks = app.marks();
      const content = marks.find((m) => m.content >= app.t0);
      return { content, committed: content && marks.find((m) => m.committed >= content.content && m.window === content.window) };
    };
    let { content, committed } = contentMarks();
    for (const end = Date.now() + 5000; !committed && Date.now() < end; await sleep(20)) ({ content, committed } = contentMarks());
    const r = {
      window: app.windowAt - app.t0,
      withContent: committed ? Math.max(app.windowAt, committed.committed) - app.t0 : NaN,
      js: app.jsStart - app.t0,
      firstPaint: (page?.fcp ?? NaN) - app.t0,
      firstFrame: (page?.frame ?? NaN) - app.t0,
      load: Math.round(loadavg()[0] * 10) / 10,
    };
    if (opt.seed) r.pageTargets = (await app.cdp.targets()).length;
    if (opt["trace-startup"]) {
      const trace = await app.waitFile("startup-trace.json", 15_000, (v) => Array.isArray(v.traceEvents));
      if (trace) {
        mkdirSync(join(side.dir, "traces"), { recursive: true });
        r.trace = join(side.dir, "traces", `launch-${i}.json`);
        execFileSync("cp", [traceFile, r.trace]);
      }
    }
    log(`${side.tag}launch ${i}:`, JSON.stringify(r));
    side.results.launch.push(r);
  } finally {
    await app.done();
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
  await sleep(3000);
}

async function idleWindow(app, secs) {
  await app.run(`ac.pause(${secs * 1000 + 1500}); return true;`);
  const probe = spawn(join(toolDir, "acperf"), ["input", String(app.pid), String(secs)], { stdio: ["ignore", "pipe", "ignore"] });
  let said = "";
  probe.stdout.on("data", (d) => (said += d));
  const probed = new Promise((done) => (probe.on("close", done), probe.on("error", done)));
  const a = usage(app.pid);
  await sleep(secs * 1000);
  const b = usage(app.pid);
  if ((await Promise.race([probed.then(() => true), sleep(2000)])) !== true) probe.kill();
  let input = null;
  try {
    input = JSON.parse(said.trim());
  } catch {}
  if (!Number.isFinite(input?.inputSecs)) input = null;
  await sleep(2000);
  const asked = Date.now();
  const late = await app.run(`return new Promise((r) => { const t = Date.now(); setTimeout(() => r(Date.now() - t - 100), 100); });`);
  return { ...usageDelta(a, b), input, afterIdle: { commandMs: Date.now() - asked, timerLateMs: late } };
}

async function throttled(app) {
  for (const t of await app.cdp.targets()) {
    const r = await app.cdp.send(t, "Runtime.evaluate", {
      expression: `document.visibilityState !== "visible" ? -1 : new Promise((done) => { let n = 0; const t0 = performance.now();
        (function f() { n++; if (performance.now() - t0 < 250) requestAnimationFrame(f); else done(n); })(); })`,
      awaitPromise: true, returnByValue: true,
    }, 3000).catch(() => null);
    const frames = r?.result?.value;
    if (typeof frames === "number" && frames >= 0) return frames < 5;
  }
  return null;
}

async function openTabs(app, from, to, kind = "static") {
  for (let i = from; i < to; i++) {
    await app.run(`ac.store.getState().newTab(${WINDOW}, { url: "${base()}/${kind}?id=t${i}" }); return true;`);
    await app.pageState(`id=t${i}`, 30_000, (s) => s.fcp);
  }
  app.track();
}

async function tabIds(app) {
  return app.run(`const s = ac.store.getState(); return s.windows[${WINDOW}].tabIds.map((id) => [id, s.tabs[id].url]);`);
}

async function newWindow(app, id) {
  const watcher = spawn(join(toolDir, "acperf"), ["newwindow", String(app.pid), "20"], { stdio: ["ignore", "pipe", "ignore"] });
  let said = "";
  watcher.stdout.on("data", (d) => (said += d));
  const exited = new Promise((done) => watcher.on("exit", done));
  for (const end = Date.now() + 10_000; !said.includes("ready") && Date.now() < end; ) await Promise.race([exited, sleep(5)]);
  const at = await app.run(`const t = ac.now(); ac.actions.openWindow({ url: "${base()}/static?id=${id}" }); return t;`);
  await exited;
  const shown = JSON.parse(said.split("\n").find((l) => l.startsWith("{")) ?? "null");
  const s = await app.pageState(`id=${id}`, 20_000, (st) => st.fcp);
  const marks = app.marks();
  const content = marks.find((m) => m.content >= at && (!shown || m.window === shown.id));
  const committed = content && marks.find((m) => m.committed >= content.content && m.window === content.window);
  await app.run(`const s = ac.store.getState(); const t = Object.values(s.tabs).find((t) => t.url.includes("id=${id}"));
    if (t) ac.store.getState().closeWindow(t.windowId); return true;`);
  await sleep(1500);
  return {
    window: shown ? shown.at - at : NaN,
    withContent: shown && committed ? Math.max(shown.at, committed.committed) - at : NaN,
    firstPaint: s ? s.fcp - at : NaN,
    firstFrame: s?.frame ? s.frame - at : NaN,
  };
}

async function windowsRun(side, i) {
  const app = new Instance(side, freshDir(side, `windows-${i}`));
  const r = { newWindow: [] };
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await sleep(10_000);
    for (let k = 0; k < 8; k++) r.newWindow.push(await newWindow(app, `w${k}`));
    log(`${side.tag}windows ${i}:`, JSON.stringify(r.newWindow));
    side.results.windows.push(r);
  } finally {
    await app.done();
  }
}

const TELEMETRY_ON = { version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "00000000-0000-4000-8000-0000000000b0", lastVersion: null, sessionOpen: false };

async function recover(app) {
  await app.run(`const s = ac.store.getState(); const w = ${WINDOW};
    if (s.windowUi[w]?.panel.open) s.closePanel(w);
    for (const id of s.windows[w].tabIds) if (!s.tabs[id].url && s.windows[w].tabIds.length > 1) ac.store.getState().closeTab(id);
    return true;`);
  await sleep(1500);
}

function postKeys(app, gap, ...specs) {
  const r = acperf("postkeys", String(app.pid), String(gap), ...specs);
  if (r.code !== 0) throw new Error(`acperf postkeys ${specs.join(" ")} failed (${r.code}): ${r.out}`);
  return r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function postSeen(app, spec) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const [press] = postKeys(app, 0, spec);
    for (const end = Date.now() + 1500; Date.now() < end; await sleep(15)) {
      const seen = app.marks().find((m) => m.keydown !== undefined && m.made >= press.at - 5 && m.made < press.at + 400);
      if (seen) return { posted: press.at, at: seen.made, attempts: attempt + 1 };
    }
  }
  return null;
}

const journeyState = (app) => app.run(`const j = ac.journeys(); const s = ac.store.getState();
  return { on: j.on, native: j.native, pending: j.pending, samples: j.samples, counts: j.counts, marks: j.marks,
    tabs: Object.keys(s.tabs).length, focused: ${FOCUSED} };`);

async function waitFor(app, accept, timeout, every = 60) {
  for (const end = Date.now() + timeout; Date.now() < end; ) {
    const st = await journeyState(app);
    if (accept(st)) return st;
    await sleep(every);
  }
  return null;
}

const sampled = (st, step) => st.samples[step]?.length ?? 0;
function markAfter(st, kind, from) {
  let first = NaN;
  for (const list of Object.values(st.marks))
    for (const [k, at] of list) if (k === kind && at >= from - 1 && !(at >= first)) first = at;
  return first;
}
const markOf = (st, key, kind, from) => (st.marks[key] ?? []).filter(([k, at]) => k === kind && at >= from - 1).map(([, at]) => at).sort((a, b) => a - b)[0] ?? NaN;

const pad2 = (n) => String(n).padStart(2, "0");

function delivery(app, at) {
  const keys = app.marks().filter((m) => m.keydown !== undefined && Math.abs(m.made - at) < 100);
  keys.sort((a, b) => Math.abs(a.made - at) - Math.abs(b.made - at));
  return keys[0] ? keys[0].keydown - keys[0].made : NaN;
}

async function openNewTab(app) {
  let press, bar = null;
  for (let attempt = 0; attempt < 2 && !bar; attempt++) {
    press = await postSeen(app, "cmd+t");
    if (!press) break;
    bar = await waitFor(app, (st) => st.pending.some((q) => q.journey === "j2" && q.bar !== undefined && q.t0 >= press.at - 5), 2500);
  }
  return { press, bar };
}

async function newTabKey(app, i, k) {
  const before = await journeyState(app);
  const { press, bar } = await openNewTab(app);
  const p = bar?.pending.filter((q) => q.journey === "j2" && q.bar !== undefined && q.t0 >= press.at - 5).at(-1);
  if (!p) return { lost: "no bar" };
  if (!(await waitFor(app, (st) => markOf(st, p.key, "typeable", press.at) >= 0, 5000, 150))) return { lost: "never typeable", tab: p.key };
  await sleep(150);
  const key = await postSeen(app, "text:n");
  if (!key) return { lost: "key never arrived", tab: p.key };
  const done = await waitFor(app, (st) => sampled(st, "j2_suggest") > sampled(before, "j2_suggest"), 8000, 120);
  if (!done) {
    const now = await journeyState(app);
    const q = now.pending.find((x) => x.key === p.key);
    const d = (v) => (v === undefined ? "-" : Math.round(v - press.at));
    return { lost: `no suggestions (pending: ${q ? `bar ${d(q.bar)} keyAt ${d(q.keyAt)} suggested ${d(q.suggested)}` : "gone"}; typed at +${Math.round(key.at - press.at)} (seen by the app after ${Math.round(delivery(app, key.at))} ms); marks ${(now.marks[p.key] ?? []).map(([k]) => k).join()})`, tab: p.key };
  }
  const last = (step) => (sampled(done, step) > sampled(before, step) ? done.samples[step].at(-1) : NaN);
  return {
    tab: p.key,
    js: p.heard - press.at,
    commit: p.bar - press.at,
    shown: markOf(done, p.key, "bar", press.at) - press.at,
    typeable: markOf(done, p.key, "typeable", press.at) - press.at,
    suggest: markOf(done, p.key, "suggest", key.at) - key.at,
    appTypeable: last("j2_typeable"),
    appSuggest: last("j2_suggest"),
    t0Skew: p.t0 - press.at,
    delivery: delivery(app, press.at),
    suggestDelivery: delivery(app, key.at),
    postGap: press.at - press.posted,
  };
}

async function navigateByEnter(app, side, id, from) {
  const url = `127.0.0.1:${server.address().port}/static?id=${id}`;
  let tab = null;
  if (from === "newtab") {
    const { press, bar } = await openNewTab(app);
    tab = bar?.pending.filter((q) => q.journey === "j2" && q.bar !== undefined && q.t0 >= press.at - 5).at(-1)?.key;
    if (!tab) return { lost: "no bar" };
    if (!(await waitFor(app, (st) => markOf(st, tab, "typeable", press.at) >= 0, 5000, 150))) return { lost: "never typeable", tab };
  } else {
    const w = JSON.stringify(await app.run(`return ${WINDOW};`));
    let open = false;
    for (let attempt = 0; attempt < 2 && !open; attempt++) {
      if (!(await postSeen(app, "cmd+l"))) continue;
      for (const end = Date.now() + 2500; !open && Date.now() < end; await sleep(60)) open = await app.run(`return !!ac.store.getState().windowUi[${w}]?.panel.open;`);
    }
    if (!open) return { lost: "no panel" };
  }
  await sleep(from === "newtab" ? 150 : 900);
  const [typed] = postKeys(app, 25, `text:${url}`);
  const arrived = () => app.marks().filter((m) => m.keydown !== undefined && m.made >= typed.at - 5 && m.made < typed.at + url.length * 60).length;
  for (const end = Date.now() + 6000; arrived() < url.length && Date.now() < end; ) await sleep(30);
  if (arrived() < url.length) return { lost: "typed keys dropped", tab };
  await journeyState(app);
  await sleep(500);
  const before = await journeyState(app);
  const enter = await postSeen(app, "enter");
  if (!enter) return { lost: "enter never arrived", tab };
  const page = await app.pageState(`id=${id}`, 20_000, (s) => s.fcp);
  const done = await waitFor(app, (st) => sampled(st, "j4_fcp") > sampled(before, "j4_fcp") || (st.counts.j4_no_load ?? 0) > (before.counts.j4_no_load ?? 0), 8000, 120);
  if (!page || !done || sampled(done, "j4_fcp") <= sampled(before, "j4_fcp")) {
    const urls = await app.run(`const s = ac.store.getState(); return Object.values(s.tabs).map((t) => t.url);`);
    return { lost: `${!page ? "no page" : "no sample"} (tabs: ${urls.map((u) => u.slice(-24)).join(" ")})`, tab };
  }
  const at = (kind) => markAfter(done, kind, enter.at) - enter.at;
  const last = (step) => (sampled(done, step) > sampled(before, step) ? done.samples[step].at(-1) : NaN);
  return {
    tab,
    request: at("request"), start: at("start"), commit: at("commit"), fcp: at("fcp"),
    engine: markAfter(done, "fcp", enter.at) - markAfter(done, "request", enter.at),
    pageFcp: page.fcp - enter.at,
    appFcp: last("j4_fcp"),
    delivery: delivery(app, enter.at),
  };
}

async function journeyRun(side, i, parts) {
  const dir = freshDir(side, `journeys-${i}`);
  writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ ...TELEMETRY_ON, crashCursor: Date.now() }));
  writeFileSync(join(dir, "bench-offline"), "1");
  const n = +opt["journey-n"];
  const app = new Instance(side, dir);
  app.env.push("AC_BENCH_KEYLOG=1");
  const r = { j2: [], j4new: [], j4page: [], lost: { j2: [], j4new: [], j4page: [] }, guard: null, load: [Math.round(loadavg()[0])] };
  const note = async (kind, x, k) => {
    if (!x.lost) return void r[kind].push(x);
    r.lost[kind].push(x.lost);
    log(`${side.tag}journeys ${i} ${kind} ${k}: lost (${x.lost})`);
    await recover(app);
  };
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await sleep(6000);
    r.guard = await app.run(`return fetch("https://ardia.dev/otel/v1/logs", { method: "POST", body: "{}" }).then((res) => {
      const j = ac.journeys();
      return { blocked: res.headers.get("x-bench-blocked"), on: j.on, native: j.native, sharing: ac.telemetry().saved.sharing };
    });`);
    if (r.guard.blocked !== "1") throw new Error("bench-offline.js isn't guarding fetch: refusing to run with sharing on");
    if (!r.guard.on || !r.guard.native) throw new Error(`field timing isn't on in the app: ${JSON.stringify(r.guard)}`);
    const closeTab = (tab) => tab && app.run(`ac.store.getState().closeTab(${JSON.stringify(tab)}); return true;`);
    if (parts.has("newtabkey")) {
      for (let k = 0; k < n; k++) {
        const x = await newTabKey(app, i, k);
        await note("j2", x, k);
        await sleep(1200);
        await closeTab(x.tab);
        await sleep(1000);
      }
      log(`${side.tag}journeys ${i} j2:`, JSON.stringify(r.j2.map((x) => Math.round(x.typeable))));
    }
    if (parts.has("navigate")) {
      for (let k = 0; k < n; k++) {
        const x = await navigateByEnter(app, side, `j${i}n${pad2(k)}`, "newtab");
        await note("j4new", x, k);
        await sleep(1500);
        await closeTab(x.tab);
        await sleep(1000);
      }
      for (let k = 0; k < n; k++) {
        const x = await navigateByEnter(app, side, `j${i}p${pad2(k)}`, "page");
        await note("j4page", x, k);
        await sleep(1800);
      }
      log(`${side.tag}journeys ${i} j4:`, JSON.stringify([r.j4new.map((x) => Math.round(x.fcp)), r.j4page.map((x) => Math.round(x.fcp))]));
    }
    r.blocked = (await app.run(`return ac.blockedFetches();`)).length;
    r.load.push(Math.round(loadavg()[0]));
    side.results.journeys.push(r);
  } finally {
    await app.done();
  }
}

const PROFILE_WARMUP_MS = 60_000;

async function profilesRun(side, i) {
  const app = new Instance(side, freshDir(side, `profiles-${i}`));
  const count = +opt["profile-count"];
  const visits = Math.min(count - 1, +(opt["profile-visits"] ?? count - 1));
  const painted = (n, since = 0) => app.pageState(`id=profile-${n}`, 30_000, (s) => s.fcp > since || (s.shown ?? []).some(([, at]) => at > since));
  const show = (n) => app.run(`const s = ac.store.getState(); const at = ac.now(); s.switchProfile(s.windowOrder[0], "${n ? `profile-${n}` : "default"}"); return at;`);
  const loadedProfiles = () => app.run(`return ac.loadedProfiles().then((profiles) => profiles.length);`).catch(() => NaN);
  try {
    await app.launch();
    if (!(await painted(0))) throw new Error("the Personal page didn't paint");
    for (let n = 1; n <= visits; n++) {
      await show(n);
      if (!(await painted(n))) throw new Error(`profile ${n}'s page didn't paint`);
    }
    await show(0);
    app.cdp.close();
    const idleMs = +opt.idle * 1000;
    const warmupMs = Math.min(idleMs, PROFILE_WARMUP_MS);
    await sleep(warmupMs);
    const before = { memory: footprint(usage(app.pid)), loaded: await loadedProfiles() };
    await sleep(idleMs - warmupMs);
    const settings = await app.run(`const s = ac.store.getState().settings; return { loadProfilesWhenOpened: s.loadProfilesWhenOpened, unloadProfilesAfter: s.unloadProfilesAfter ?? null, memorySaver: s.memorySaver };`);
    const after = { memory: footprint(usage(app.pid)), loaded: await loadedProfiles() };
    let back = NaN, reloaded = null;
    if (visits) {
      const at = await show(1);
      const page = await painted(1, at);
      reloaded = !!page && page.fcp > at;
      back = page ? (reloaded ? page.fcp : Math.min(...page.shown.map(([, shown]) => shown).filter((shown) => shown > at))) - at : NaN;
    }
    const result = { profiles: count, visits, warmupMs, idleMs, settings, before, after, back, reloaded, loadedAfterBack: await loadedProfiles(), load: Math.round(loadavg()[0] * 10) / 10 };
    side.results.profiles.push(result);
    log(`${side.tag}profiles ${i}: ${before.loaded} → ${after.loaded} profiles loaded, ${before.memory.totalMB.toFixed(0)} → ${after.memory.totalMB.toFixed(0)} MB, back to a profile ${back.toFixed(0)} ms${reloaded ? " (loaded again)" : ""}`);
    await app.done();
  } finally {
    await app.quit();
  }
}

const SESSION_PARTS = ["idle", "memory", "switch", "newtab", "newwindow"];

const jsHeap = (app) => app.run(`const s = globalThis.HermesInternal?.getInstrumentedStats?.(); return s ? { heapMB: s.js_heapSize / 1048576, allocatedMB: s.js_allocatedBytes / 1048576 } : null;`).catch(() => null);

async function sessionRun(side, i, parts) {
  const has = (part) => parts.has(part);
  const secs = +opt.idle;
  const app = new Instance(side, freshDir(side, `session-${i}`));
  const r = { memory: {}, heap: {}, idle: {}, tabSwitch: [], newTab: [], newTabFrame: [], newWindow: [], processes: {}, throttled: { tabSwitch: 0, newTab: 0 } };
  if (parts.size < SESSION_PARTS.length) r.parts = [...parts];
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    if (has("idle") || has("memory")) await sleep(+opt["launch-settle"] * 1000);
    if (has("idle")) r.idle.tabs1 = await idleWindow(app, secs);
    if (has("memory")) r.memory.tabs1 = footprint(usage(app.pid)), r.heap.tabs1 = await jsHeap(app);
    await openTabs(app, 1, 10);
    if (has("memory")) {
      await sleep(10_000);
      r.memory.tabs10 = footprint(usage(app.pid));
      r.heap.tabs10 = await jsHeap(app);
    }
    await openTabs(app, 10, 20);
    await sleep(15_000);
    if (has("memory")) r.memory.tabs20 = footprint(usage(app.pid)), r.heap.tabs20 = await jsHeap(app);
    if (has("idle")) r.idle.tabs20 = await idleWindow(app, secs);

    const tabs = has("switch") ? (await tabIds(app)).filter(([, url]) => url.includes("/static?id=t")) : [];
    for (let k = 0; k < (has("switch") ? 16 : 0); k++) {
      const [id, url] = tabs[(k * 7 + 3) % tabs.length];
      const marker = url.match(/id=(t\d+)/)[1];
      const target = await app.cdp.find(`id=${marker}`);
      const before = (await app.cdp.state(target))?.shown?.length ?? 0;
      const hidden = await throttled(app);
      const at = await app.run(`const t = ac.now(); ac.actions.switchToTab(${JSON.stringify(id)}); return t;`);
      const s = await app.pageState(`id=${marker}`, 5000, (st) => (st.shown?.length ?? 0) > before);
      const shown = s?.shown.at(-1);
      if (hidden) r.throttled.tabSwitch++;
      r.tabSwitch.push(shown && !hidden ? shown[1] - at : NaN);
      if (process.env.BENCH_DEBUG) log("switch", marker, "before", before, "at", at - Date.now(), "state", JSON.stringify((await app.cdp.state(target)) ?? null)?.slice(0, 300));
      await sleep(400);
    }

    for (let k = 0; k < (has("newtab") ? 5 : 0); k++) {
      const hidden = await throttled(app);
      const at = await app.run(`const t = ac.now(); ac.store.getState().newTab(${WINDOW}, { url: "${base()}/static?id=n${k}" }); return t;`);
      const s = await app.pageState(`id=n${k}`, 20_000, (st) => st.fcp);
      if (hidden) r.throttled.newTab++;
      r.newTab.push(s && !hidden ? s.fcp - at : NaN);
      r.newTabFrame.push(s?.frame && !hidden ? s.frame - at : NaN);
      await sleep(800);
    }
    if (has("newtab"))
      await app.run(`const s = ac.store.getState(); for (const id of Object.keys(s.tabs)) if (s.tabs[id].url.includes("id=n")) ac.store.getState().closeTab(id); return true;`);

    for (let k = 0; k < (has("newwindow") ? 3 : 0); k++) r.newWindow.push(await newWindow(app, `w${k}`));

    if (has("memory")) {
      r.processes.tabs20 = usage(app.pid).length;
      await app.run(`const s = ac.store.getState(); const w = ${WINDOW}; const keep = s.windows[w].tabIds.find((id) => s.tabs[id].url.includes("id=seed"));
        ac.store.getState().activate(keep); for (const id of s.windows[w].tabIds) if (id !== keep) ac.store.getState().closeTab(id); return true;`);
      await sleep(+opt["close-settle"] * 1000);
      r.memory.closed = footprint(usage(app.pid));
      r.heap.closed = await jsHeap(app);
      r.processes.closed = r.memory.closed.processes;
    }
  } finally {
    await app.done();
  }
  log(`${side.tag}session ${i}:`, JSON.stringify({ idle: r.idle, mem: Object.fromEntries(Object.entries(r.memory).map(([k, v]) => [k, Math.round(v.totalMB)])), sw: r.tabSwitch, nt: r.newTab, nw: r.newWindow }));
  side.results.session.push(r);
}

const ACTIVE_TAB = `(() => { const s = ac.store.getState(); const w = s.windows[${WINDOW}]; const id = w.activeTabIds[w.profileId];
  return { id, url: s.tabs[id]?.url ?? null, appLoading: ac.tabLive ? !!ac.tabLive.shownLiveOf(s, id).isLoading : null }; })()`;

async function fixturePage(app) {
  try {
    const target = await app.cdp.find("id=load");
    if (!target) return null;
    const reply = await app.cdp.send(target, "Runtime.evaluate", { expression: "({ url: location.href, state: document.readyState })", returnByValue: true });
    return reply?.result?.value ?? null;
  } catch {
    return null;
  }
}

async function activeLoading(app) {
  const tab = await app.run(`return ${ACTIVE_TAB};`);
  const page = tab.url?.includes(LOADING_FIXTURE) ? await fixturePage(app) : null;
  const pageLoading = page?.url?.includes(LOADING_FIXTURE) ? page.state === "loading" : null;
  return { ...tab, pageLoading, loading: tab.appLoading ?? pageLoading ?? false };
}

async function loadingRun(side, i) {
  const secs = +opt.idle;
  const app = new Instance(side, freshDir(side, `loading-${i}`));
  const r = { load: [Math.round(loadavg()[0] * 10) / 10] };
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await sleep(30_000);
    r.loadedBefore = await activeLoading(app);
    r.loaded = await idleWindow(app, secs);
    await app.run(`ac.store.getState().newTab(${WINDOW}, { url: "${base()}${LOADING_FIXTURE}" }); return true;`);
    await app.pageState("id=load", 30_000, (s) => s.vis);
    let state = null;
    for (const end = Date.now() + 20_000; Date.now() < end && !(state?.loading && state.url?.includes(LOADING_FIXTURE)); await sleep(100)) state = await activeLoading(app);
    r.loadingBefore = state;
    await sleep(3000);
    r.loading = await idleWindow(app, secs);
    r.loadingAfter = await activeLoading(app);
    r.load.push(Math.round(loadavg()[0] * 10) / 10);
  } finally {
    for (const res of hanging) res.destroy();
    await app.done();
  }
  const brief = (w) => w && { wakeups: +w.kinds.browser?.wakeups.toFixed(1), cpu: +w.kinds.browser?.cpu.toFixed(2), all: +w.total.wakeups.toFixed(1) };
  log(`${side.tag}loading ${i}:`, JSON.stringify({ loaded: brief(r.loaded), loading: brief(r.loading), appLoading: [r.loadingBefore?.loading, r.loadingAfter?.loading], load: r.load }));
  side.results.loading.push(r);
}

async function throttleRun(side) {
  const app = new Instance(side, freshDir(side, "throttle"));
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await openTabs(app, 0, 4, "anim");
    await app.run(`const s = ac.store.getState(); const w = ${WINDOW}; ac.store.getState().activate(s.windows[w].tabIds.find((id) => s.tabs[id].url.includes("id=seed"))); return true;`);
    await sleep(12_000);
    const read = async () => {
      const out = {};
      for (const t of await app.cdp.targets()) if (t.url.includes("/anim?") || t.url.includes("id=seed")) out[t.url.match(/id=(\w+)/)[1]] = await app.cdp.state(t);
      return out;
    };
    const a = await read();
    const t0 = Date.now();
    await sleep(10_000);
    const b = await read();
    const secs = (Date.now() - t0) / 1000;
    const tabs = {};
    for (const [id, s] of Object.entries(b)) {
      const p = a[id];
      if (!s || !p) continue;
      tabs[id] = { visibility: s.visibility, rafPerSec: (s.raf - p.raf) / secs, fastTimerPerSec: (s.fast - p.fast) / secs, secondTimerPerSec: (s.ticks - p.ticks) / secs };
    }
    const idle = await idleWindow(app, 20);
    side.results.throttle.push({ tabs, idle });
    log(`${side.tag}throttle:`, JSON.stringify(tabs), JSON.stringify(idle.total));
  } finally {
    await app.done();
  }
}

async function churnRun(side) {
  const app = new Instance(side, freshDir(side, "churn"));
  const rounds = [];
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await sleep(10_000);
    const measure = () => {
      const f = footprint(usage(app.pid));
      return { browserMB: f.kinds.browser, totalMB: f.totalMB, processes: f.processes };
    };
    rounds.push(measure());
    for (let round = 0; round < 5; round++) {
      await openTabs(app, round * 10, round * 10 + 10);
      await app.run(`const s = ac.store.getState(); const w = ${WINDOW}; const keep = s.windows[w].tabIds.find((id) => s.tabs[id].url.includes("id=seed"));
        ac.store.getState().activate(keep); for (const id of s.windows[w].tabIds) if (id !== keep) ac.store.getState().closeTab(id); return true;`);
      await sleep(15_000);
      rounds.push(measure());
    }
    side.results.churn = rounds;
    log(`${side.tag}churn:`, JSON.stringify(rounds.map((r) => Math.round(r.browserMB))));
  } finally {
    await app.done();
  }
}

async function sampleRun(side) {
  const app = new Instance(side, freshDir(side, "sample"));
  const dir = join(side.dir, "samples");
  mkdirSync(dir, { recursive: true });
  try {
    await app.launch();
    await app.pageState("id=seed", 30_000, (s) => s.fcp);
    await openTabs(app, 1, 20);
    await sleep(15_000);
    await app.run(`ac.pause(40000); return true;`);
    execFileSync("sample", [String(app.pid), "10", "-mayDie", "-file", join(dir, "idle.txt")], { stdio: "ignore" });
    const tabs = await tabIds(app);
    const sampler = spawn("sample", [String(app.pid), "12", "-mayDie", "-file", join(dir, "switch-scroll.txt")], { stdio: "ignore" });
    const end = Date.now() + 11_000;
    for (let k = 0; Date.now() < end; k++) {
      const [id, url] = tabs[(k * 7 + 3) % tabs.length];
      await app.run(`ac.actions.switchToTab(${JSON.stringify(id)}); return true;`);
      const target = await app.cdp.find(url.match(/id=\w+/)[0]);
      if (target) for (let n = 0; n < 6; n++) await app.cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 120 });
      await sleep(150);
    }
    await new Promise((ok) => sampler.on("exit", ok));
    side.results.sample.push({ idle: summarizeSample(join(dir, "idle.txt")), active: summarizeSample(join(dir, "switch-scroll.txt")) });
    log(`${side.tag}samples in`, dir);
  } finally {
    await app.done();
  }
}

function summarizeSample(file) {
  const text = readFileSync(file, "utf8");
  const thread = text.split(/\n(?=    \d+ Thread_)/).find((t) => /com\.apple\.main-thread|DispatchQueue_1:/.test(t.split("\n")[0])) ?? "";
  const total = +(thread.match(/^\s+(\d+) Thread_/)?.[1] ?? 0);
  const idleWait = [...thread.matchAll(/^\s*[+!:| ]*(\d+) mach_msg2_trap/gm)].reduce((n, m) => n + +m[1], 0);
  const count = (re) => [...thread.matchAll(new RegExp(`^\\s*[+!:| ]*(\\d+) [^\\n]*${re}`, "gm"))].reduce((n, m) => Math.max(n, +m[1]), 0);
  return {
    samples: total,
    waiting: idleWait,
    busy: total - idleWait,
    engineWork: count("CefDoMessageLoopWork|MessagePumpCFRunLoopBase::RunWorkSource"),
    metalDraw: count("MTKView draw|\\bdraw\\(in:"),
    caCommit: count("CA::Transaction::commit"),
    rnLayout: count("RCTUIManager|YGNodeCalculateLayout"),
    hermes: count("hermes::vm::"),
  };
}

function printTable(rows, other, names = ["Before", "After"]) {
  const fmt = (r) =>
    Number.isFinite(r?.median) ? `${r.median.toFixed(r.digits)} ${r.unit}${r.p75 === undefined ? "" : `, p75 ${r.p75.toFixed(r.digits)}`} (${r.min.toFixed(r.digits)}–${r.max.toFixed(r.digits)}, n=${r.n})` : "—";
  const lines = other
    ? [`| Metric | ${names[0]} | ${names[1]} |`, "|---|---|---|", ...rows.map((r) => `| ${r.name} | ${fmt(other.find((o) => o.name === r.name))} | ${fmt(r)} |`)]
    : ["| Metric | Median (min–max, runs) |", "|---|---|", ...rows.map((r) => `| ${r.name} | ${fmt(r)} |`)];
  console.log(lines.join("\n"));
}

if (opt.report) {
  const other = opt.compare ? summary(JSON.parse(readFileSync(opt.compare, "utf8"))) : null;
  printTable(summary(JSON.parse(readFileSync(opt.report, "utf8"))), other);
  process.exit(0);
}
const fail = (message) => {
  console.error(message);
  process.exit(64);
};
if (!opt.app) fail("usage: native-bench.mjs --app <Ardia.app> [--control <app>] [--out dir] [--only phases] … (--help)");
const JOURNEY_PHASES = ["newtabkey", "navigate"];
const FRAME_PHASES = ["frames", "framecounts"];
const PHASES = ["launch", "session", ...SESSION_PARTS, ...JOURNEY_PHASES, ...FRAME_PHASES, "profiles", "windows", "throttle", "churn", "loading", "sample", "prepare"];
const only = new Set(opt.only.split(",").map((p) => p.trim()).filter(Boolean));
for (const p of only) if (!PHASES.includes(p)) fail(`--only: no phase "${p}"; phases: ${PHASES.join(", ")}`);
if (only.has("frames") || only.has("framecounts")) opt.seed ??= "big";
if (opt.seed && opt.seed !== "big") fail(`--seed: only "big" exists, got "${opt.seed}"`);
if (opt["fresh-copy"] && ![...only].every((p) => p === "launch" || p === "prepare")) fail("--fresh-copy works with --only launch");
if (opt["trace-startup"] && ![...only].every((p) => p === "launch")) fail("--trace-startup works with --only launch");
if (opt.seed && ![...only].every((p) => p === "launch" || p === "prepare" || JOURNEY_PHASES.includes(p) || FRAME_PHASES.includes(p))) fail("--seed big works with --only launch, newtabkey, navigate, frames and framecounts (the other phases measure a one-tab session)");
for (const e of opt.env) if (!/^[A-Za-z_]\w*=/.test(e)) fail(`--env wants K=V, got "${e}"`);
if (!(+opt.hold >= 0)) fail(`--hold wants seconds, got "${opt.hold}"`);
if (only.has("profiles")) {
  if (only.size !== 1 || opt.seed) fail("--only profiles runs alone, with its own seed");
  if (!Number.isSafeInteger(+opt["profile-count"]) || +opt["profile-count"] < 2) fail(`--profile-count wants a whole number of at least 2, got "${opt["profile-count"]}"`);
  if (opt["profile-visits"] !== undefined && !(Number.isSafeInteger(+opt["profile-visits"]) && +opt["profile-visits"] >= 0)) fail(`--profile-visits wants a whole number, got "${opt["profile-visits"]}"`);
} else if ((opt.setting.length || opt["control-setting"].length) && !opt.seed) fail("--setting and --control-setting work with --only profiles and with --seed big");
try {
  parseSettings([...opt.setting, ...opt["control-setting"]]);
} catch (error) {
  fail(error.message);
}
if (opt.control && opt.compare) log("--compare is ignored with --control: the control is the before column");

const labelOf = (app) => basename(dirname(dirname(resolve(app))));
function makeSide(app, label, role) {
  const dir = join(opt.out, label);
  mkdirSync(dir, { recursive: true });
  return { role, label, tag: "", src: resolve(app), dir, template: join(dir, "template"), app: null, bundle: null,
    results: { meta: {}, profiles: [], launch: [], session: [], windows: [], journeys: [], frames: [], throttle: [], loading: [], sample: [] } };
}
const candidate = makeSide(opt.app, opt.label ?? labelOf(opt.app), "candidate");
let control = null;
if (opt.control) {
  let label = opt["control-label"] ?? labelOf(opt.control);
  if (label === candidate.label) label += "-control";
  control = makeSide(opt.control, label, "control");
  candidate.tag = `${candidate.label} `;
  control.tag = `${control.label} `;
}
const sides = control ? [candidate, control] : [candidate];

async function interleaved(n, fn) {
  for (let i = 0; i < n; i++) for (const side of !control ? sides : i % 2 ? [candidate, control] : [control, candidate]) await fn(side, i);
}

const cleanup = async () => {
  for (const app of [...live]) await app.quit().catch(() => {});
  server?.close();
};
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]])
  process.on(sig, async () => {
    log(`${sig === "SIGINT" ? "interrupted" : "terminated"}: quitting the instance`);
    await cleanup();
    process.exit(code);
  });

try {
  server = await startServer();
  for (const side of sides) {
    if (opt.prepared) {
      const from = checkPrepared(side.src);
      side.app = side.src;
      side.bundle = join(side.app, "Contents/Resources/main.jsbundle");
      side.results.meta.preparedFrom = from;
    } else {
      const own = side === control ? opt["control-bundle"] : opt.bundle;
      side.bundle = own ? resolve(own) : side === control ? candidate.bundle : buildBundle(join(side.dir, "bundle"));
      side.app = prepareBenchApp(side.src, join(side.dir, "app"), side.bundle);
    }
    const other = sides.find((s) => s !== side);
    side.results.meta.source = side.results.meta.preparedFrom?.source ?? appIdentity(side.src);
    side.results.meta.bundleSha = fileSha256(join(side.app, "Contents/Resources/main.jsbundle"));
    Object.assign(side.results.meta, { app: side.src, bundle: side.bundle, label: side.label, date: new Date().toISOString(),
      runs: +opt.runs, launchRuns: +opt["launch-runs"], idleSecs: +opt.idle, launchSettleSecs: +opt["launch-settle"], closeSettleSecs: +opt["close-settle"], only: [...only], env: opt.env, seed: opt.seed ?? null, freshCopy: !!opt["fresh-copy"], ...(other ? { role: side.role, interleavedWith: other.label } : {}) });
  }
  await makeTemplates();
  if (only.has("prepare")) {
    for (const side of sides) console.log(`prepared ${side.app} (rerun with --app ${side.app} --prepared)`);
    process.exit(0);
  }
  if (only.has("profiles")) await interleaved(+opt.runs, profilesRun);
  if (only.has("launch")) await interleaved(+opt["launch-runs"], launchRun);
  const parts = new Set(SESSION_PARTS.filter((p) => only.has("session") || only.has(p)));
  if (parts.size) await interleaved(+opt.runs, (side, i) => sessionRun(side, i, parts));
  const framesCtx = { Instance, freshDir, acperf, sleep, log, WINDOW, base, opt, toolDir, loadavg, out: opt.out };
  if (only.has("frames")) await interleaved(+opt.runs, (side, i) => framesRun(framesCtx, side, i, { counts: false }));
  if (only.has("framecounts")) await interleaved(+opt.runs, (side, i) => framesRun(framesCtx, side, i, { counts: true }));
  const journeys = new Set(JOURNEY_PHASES.filter((p) => only.has(p)));
  if (journeys.size) await interleaved(+opt.runs, (side, i) => journeyRun(side, i, journeys));
  if (only.has("windows")) await interleaved(+opt.runs, windowsRun);
  if (only.has("throttle")) await interleaved(1, throttleRun);
  if (only.has("churn")) await interleaved(1, churnRun);
  if (only.has("loading")) await interleaved(+opt.runs, loadingRun);
  if (only.has("sample")) await interleaved(1, sampleRun);
  for (const side of sides) writeFileSync(join(side.dir, "results.json"), JSON.stringify(side.results, null, 1));
  const rows = summary(candidate.results);
  if (control) printTable(rows, summary(control.results), [`${control.label} (control)`, candidate.label]);
  else printTable(rows, opt.compare ? summary(JSON.parse(readFileSync(opt.compare, "utf8"))) : null);
  for (const { results, tag } of sides) {
    if (results.throttle.length) console.log(`\n${tag}Hidden tabs:`, JSON.stringify(results.throttle[0].tabs));
    if (results.churn) console.log(`\n${tag}Browser process after each open/close-10-tabs round (MB):`, results.churn.map((r) => Math.round(r.browserMB)).join(" → "));
    if (results.sample.length) console.log(`${tag}Main thread samples:`, JSON.stringify(results.sample[0]));
  }
  if (sides.some((x) => x.results.frames.length)) console.log(`\n${frameTable(Object.fromEntries(sides.map((x) => [x.label, x.results])))}`);
  if (control) console.log(`\nresults: ${join(candidate.dir, "results.json")}, ${join(control.dir, "results.json")}`);
} finally {
  await cleanup();
}
