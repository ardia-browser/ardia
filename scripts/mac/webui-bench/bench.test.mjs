import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DRAG_EDGE_OFFSETS, MEASURES, captureOrClose, pacingProblem, PAIRED_PROFILE, blockScript, dragChanged, firstWindowTiming, instanceName, scenarioOrder, waitGone, judgeBlock, overlapMs, parseBenchArgs, phasesFor, planBench, rnCopyDir, runStatus, schedule, subErrors, summarizeRuns, swipeBlankFrames, swipesFor, teardownAfter, validWindow, pagerMotion } from "./bench.mjs";
import { assertTraceComplete, epochOffset, marksOf, openSocket, screenshotsOf, traced } from "./cdp.mjs";
import { LATE_120_MS, analyze, windowGaps, differs, freshFrames, inputLatencies, isBlank, restFromFrames, settleMs, splitFrames } from "./frames.mjs";
import { RULES, baselineProblems, blockedProblem, evaluate, fixtureProblem, integrity, judge, limitFor, markdown, parseGateArgs, regressed, validateReport, validateRules } from "./gate.mjs";
import {
  ACSWIPE, OWNED_MARKER, OWNER_SWITCH, footprintResult, signalOwned, isMainWindow, ownerRootPid, startTracker, watchFirstWindow, withTracker, assertBuild, assertHidden, assertScratch, canonicalPath, cleanupRegistry, fileProbe, hiddenOpenArgs, isInside, isOwnedDir, trackOwned,
  makeOwnedDir, makeOwnedRoot, ownedTree, parseFootprint, parseProcessRows, parseRss, processIdentity, readProcessRows, removeOwnedDir, sameProcess, stopOwned,
} from "./hidden.mjs";
import { PROFILES, SETTINGS, SESSION_VERSION, benchSession, expectedFixture, multiSession, selectedUrl, smallSession, tableSession, validateSession } from "./seed.mjs";
import { median, percentile, summarize } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const scratch = () => mkdtempSync(join(tmpdir(), "webui-bench-test-"));
const SIZE = 400;
const flat = (v) => new Uint8Array(SIZE).fill(v);
const pattern = (seed) => Uint8Array.from({ length: SIZE }, (_, i) => ((i * 7 + seed * 31) % 200) + 20);
const node = (script, ...args) => spawnSync(process.execPath, [join(here, script), ...args], { encoding: "utf8" });

test("stats: median, percentile and summarize ignore non-numbers", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([10, 20, 30, 40, 50], 95), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.deepEqual(summarize([5, null, undefined, NaN, 1, 3]), { median: 3, p95: 5, max: 5, n: 3 });
});

test("frames: identical frames are not new, a changed frame is", () => {
  assert.equal(differs(flat(100), flat(100)), false);
  assert.equal(differs(flat(100), flat(110)), false);
  assert.equal(differs(flat(100), flat(130)), true);
  const nearly = flat(100);
  nearly[0] = 200;
  assert.equal(differs(flat(100), nearly), true);
  assert.equal(differs(flat(1), new Uint8Array(3)), true);
});

test("frames: splitting refuses a zero-byte or ragged first frame instead of looping", () => {
  assert.throws(() => splitFrames(Buffer.alloc(10), 0), /0 bytes/);
  assert.throws(() => splitFrames(Buffer.alloc(10), NaN), /bytes/);
  assert.throws(() => splitFrames(Buffer.alloc(10), 4), /whole number/);
  assert.equal(splitFrames(Buffer.alloc(12), 4).length, 3);
  assert.throws(() => splitFrames(Buffer.alloc(0), 4), /no frames/);
  assert.throws(() => splitFrames(null, 4), /no frames/);
});

test("frames: blank detection needs one flat colour", () => {
  assert.equal(isBlank(flat(240)), true);
  assert.equal(isBlank(pattern(1)), false);
  assert.equal(isBlank(new Uint8Array(0)), false);
});

test("frames: slide gaps, settle and late row paint on a synthetic swipe", () => {
  const frames = [];
  const times = [];
  for (let i = 0; i < 30; i++) {
    times.push(i * 8.3);
    frames.push(i < 20 ? pattern(i) : pattern(19));
  }
  frames.push(pattern(99));
  times.push(400);
  const r = analyze({ frames, times, rest: 160 });
  assert.equal(r.frames, 31);
  assert.equal(r.newFrames, 20);
  assert.equal(r.slideFrames, 19);
  assert.equal(r.p50GapMs, 8.3);
  assert.equal(r.maxGapMs, 242.3);
  assert.equal(r.longGaps, 1);
  assert.equal(r.rowsPaintedMs, 240);
  assert.equal(r.blankFrames, 0);
  assert.equal(r.restAt, 160);
});

test("frames: a row painted 45 ms after rest counts, no deadband hides it", () => {
  const r = analyze({ frames: [pattern(0), pattern(1), pattern(2), pattern(3)], times: [0, 50, 100, 145], rest: 100 });
  assert.equal(r.rowsPaintedMs, 45);
  assert.equal(r.slideFrames, 2);
  const gate = judge({ key: "swipe.back.rowsPaintedMs", label: "row", vsRn: true, budget: 16 }, { summary: { rn: { "swipe.back.rowsPaintedMs": { median: 0 } }, webui: { "swipe.back.rowsPaintedMs": { median: r.rowsPaintedMs } } } });
  assert.equal(gate.verdict, "FAIL");
});

test("frames: frame 0 and persistent blank frames are counted, not only changed ones", () => {
  const first = analyze({ frames: [flat(250), pattern(1), pattern(2)], times: [0, 16, 32] });
  assert.equal(first.blankFrames, 1);
  assert.equal(first.firstFrameBlank, true);
  const held = analyze({ frames: [pattern(0), flat(250), flat(250), flat(250)], times: [0, 16, 32, 48] });
  assert.equal(held.newFrames, 1);
  assert.equal(held.blankFrames, 3);
  const stall = analyze({ frames: [pattern(0), pattern(1), pattern(2), flat(250), pattern(4), pattern(5)], times: [0, 16, 32, 48, 148, 164] });
  assert.equal(stall.maxGapMs, 100);
  assert.equal(stall.longGaps, 1);
  assert.equal(stall.blankFrames, 1);
  assert.deepEqual(freshFrames([pattern(0), pattern(0), pattern(1)], [0, 1, 2]), [2]);
});

test("frames: rest needs a real stationary interval", () => {
  const samples = [[1000, 0], [1004, 0], [1008, 5], [1012, 30], [1300, 100], [1304, 100], [1600, 100]];
  assert.deepEqual(settleMs(samples), { startAt: 1008, restAt: 1300, restMs: 292, settled: true });
  assert.deepEqual(settleMs([[0, 0], [4, 5], [8, 10], [12, 10]]), { startAt: 4, restAt: null, restMs: null, settled: false });
  assert.deepEqual(settleMs([[0, 0], [4, 5], [8, 10], [12, 10], [40, 10]]), { startAt: 4, restAt: null, restMs: null, settled: false });
  assert.equal(settleMs([[0, 1], [4, 1]]).restAt, null);
  assert.equal(restFromFrames([10, 50], 200), 50);
  assert.equal(restFromFrames([10, 50], 120), null);
  assert.equal(restFromFrames([], 500), null);
  const moving = analyze({ frames: [pattern(0), pattern(1), pattern(2)], times: [0, 16, 32], endAt: 60 });
  assert.equal(moving.restAt, null);
  const still = analyze({ frames: [pattern(0), pattern(1), pattern(2)], times: [0, 16, 32], endAt: 200 });
  assert.equal(still.restAt, 32);
});

test("frames: keystroke latency is the first new frame after each key, before the next key", () => {
  assert.deepEqual(inputLatencies([10, 120, 600], [0, 100, 200, 300]), [10, 20, null, null]);
  assert.deepEqual(inputLatencies([290], [0], 250), [null]);
  const r = analyze({ frames: [pattern(0), pattern(0), pattern(1), pattern(1), pattern(2)], times: [0, 10, 20, 160, 175], inputs: [5, 150] });
  assert.deepEqual(r.inputLatenciesMs, [15, 25]);
  assert.equal(r.missedInputs, 0);
});

test("seed: every bench session is a valid version 11 session with the spike's shape", () => {
  for (const make of [benchSession, smallSession, multiSession]) assert.deepEqual(validateSession(make("http://127.0.0.1:9600")), []);
  const large = benchSession();
  assert.equal(large.version, SESSION_VERSION);
  assert.equal(SESSION_VERSION, 11);
  assert.ok(large.tabs.every((t) => t.page.kind === "idle" && t.pin === null));
  assert.equal(large.tabs.length, PROFILES.reduce((n, p) => n + p.tabs, 0));
  assert.deepEqual(large.windows[0].frame, [60, 60, 1360, 820]);
  assert.equal(large.windows[0].tabIds.indexOf("default-t130"), 130);
  assert.equal(selectedUrl(large), "http://127.0.0.1:9600/default/t130");
  assert.deepEqual(expectedFixture(large), { profiles: 3, tabs: 170, windows: 1 });
  assert.deepEqual(expectedFixture(smallSession()), { profiles: 3, tabs: 3, windows: 1 });
  const multi = multiSession();
  assert.deepEqual(expectedFixture(multi), { profiles: 3, tabs: 178, windows: 2 });
  assert.ok(multi.tabs.filter((t) => t.windowId === "second").every((t) => t.profileId === "work"));
  assert.equal(Object.keys(tableSession(large).tabs).length, large.tabs.length);
});

test("seed: validation catches broken and stale sessions", () => {
  const s = benchSession();
  s.windows[0].activeTabIds.work = "default-t1";
  s.windows[0].tabIds.push("ghost");
  s.tabs.push({ ...s.tabs[0] });
  s.version = 2;
  const problems = validateSession(s);
  assert.ok(problems.some((p) => p.includes("selects default-t1 for work")));
  assert.ok(problems.some((p) => p.includes("missing tab ghost")));
  assert.ok(problems.some((p) => p.includes("repeats")));
  assert.ok(problems.some((p) => p.includes("version is 2")));
});

test("seed: the CLI prints a valid session and has --help", () => {
  const help = node("seed.mjs", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /version 11/);
  const out = node("seed.mjs", "multi", "--origin", "http://127.0.0.1:1");
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).version, 11);
  assert.equal(node("seed.mjs", "nope").status, 64);
});

test("schedule: abab alternates strictly and abba flips each rep, both balanced", () => {
  const s = schedule(5);
  assert.equal(s.map((x) => x.side).join(" "), "rn webui rn webui rn webui rn webui rn webui");
  assert.deepEqual(s.map((x) => x.slot), [...s.keys()]);
  const f = schedule(4, "abba");
  assert.equal(f.map((x) => x.side).join(" "), "rn webui webui rn rn webui webui rn");
  for (let rep = 0; rep < 4; rep++) assert.deepEqual(f.filter((x) => x.rep === rep).map((x) => x.side).sort(), ["rn", "webui"]);
});

test("bench args: validation and dry-run plan", () => {
  const out = scratch();
  const base = ["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out];
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app"]), /required/);
  assert.throws(() => parseBenchArgs([...base, "--reps", "0"]), /reps/);
  assert.throws(() => parseBenchArgs([...base, "--order", "aabb"]), /order/);
  assert.throws(() => parseBenchArgs([...base, "--only", "launch,vibes"]), /only/);
  const o = parseBenchArgs([...base, "--reps", "3", "--dry-run"]);
  const plan = planBench(o, 9777);
  assert.equal(plan.slots.length, 6);
  assert.deepEqual(plan.phases, ["small", "large", "multi"]);
  assert.equal(plan.launches.length, 18);
  assert.ok(plan.launches.every((l) => l.data.startsWith(join(out, "run-"))));
  assert.equal(new Set(plan.launches.map((l) => l.data)).size, plan.launches.length);
  assert.ok(plan.webuiOpenArgs.indexOf("-g") < plan.webuiOpenArgs.indexOf("--args"));
  assert.ok(plan.webuiOpenArgs.includes(`${OWNER_SWITCH}=dry-run`));
  assert.ok(plan.webuiOpenArgs.includes("--remote-debugging-port=9777"));
  assert.deepEqual(plan.sessions.multi, { profiles: 3, tabs: 178, windows: 2 });
  assert.deepEqual(phasesFor(["swipe"]), ["large"]);
  assert.equal(instanceName("rn", "large", 0), "rn-large-1");
  const cli = node("bench.mjs", ...base, "--reps", "2", "--only", "launch", "--dry-run");
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).slots.length, 4);
  assert.equal(node("bench.mjs", "--reps", "2").status, 64);
});

test("paths: protected roots are refused through case changes and symlinks", () => {
  assert.equal(canonicalPath("/tmp/X/Y", { caseInsensitive: true }), canonicalPath("/tmp/x/y", { caseInsensitive: true }));
  assert.throws(() => assertScratch(join(HOME, "Documents", "bench")), /refusing/);
  assert.throws(() => assertScratch(join(HOME, "documents", "bench")), /refusing/);
  assert.throws(() => assertScratch(join(HOME, "LIBRARY/Application Support/Ardia")), /refusing/);
  assert.throws(() => assertScratch(HOME), /scratch|home/);
  assert.throws(() => assertScratch(join(HOME, "..")), /refusing/);
  const dir = scratch();
  const link = join(dir, "docs");
  symlinkSync(join(HOME, "Documents"), link);
  assert.throws(() => assertScratch(join(link, "nested", "bench")), /refusing/);
  assert.throws(() => assertBuild("/Applications/Ardia.app"), /installed/);
  assert.throws(() => assertBuild("/applications/Ardia.app"), /installed/);
  assert.throws(() => assertBuild("/Applications/Utilities/Test.app"), /installed/);
  assert.throws(() => assertBuild(join(HOME, "applications", "Ardia.app")), /installed/);
  const appLink = join(dir, "Linked.app");
  symlinkSync("/Applications", join(dir, "apps"));
  symlinkSync(join(dir, "apps"), appLink);
  assert.throws(() => assertBuild(join(appLink, "Ardia.app")), /installed/);
  assert.equal(assertBuild("/tmp/b/Ardia WebUI.app"), "/tmp/b/Ardia WebUI.app");
  assert.equal(assertScratch(join(dir, "ok")), join(dir, "ok"));
});

test("paths: the guard folds case and follows dangling links on every OS, whatever exists under HOME", () => {
  assert.equal(canonicalPath("/tmp/WebUI-Bench-Case/X"), canonicalPath("/tmp/webui-bench-case/x"));
  assert.equal(canonicalPath("/tmp/WebUI-Bench-Case/X", { caseInsensitive: false }).endsWith("WebUI-Bench-Case/X"), true);
  const fakeHome = join(scratch(), "home-that-does-not-exist");
  assert.throws(() => assertScratch(join(fakeHome, "documents", "bench"), { home: fakeHome }), /refusing/);
  assert.throws(() => assertScratch(join(fakeHome, "Library", "Application Support", "Ardia"), { home: fakeHome }), /refusing/);
  assert.throws(() => assertBuild(join(fakeHome, "Applications", "Ardia.app"), { home: fakeHome }), /installed/);
  const links = scratch();
  symlinkSync(join(fakeHome, "Documents"), join(links, "dangling"));
  assert.throws(() => assertScratch(join(links, "dangling", "bench"), { home: fakeHome }), /refusing/);
  symlinkSync(join(links, "loop"), join(links, "loop"));
  assert.equal(assertScratch(join(links, "loop", "x"), { home: fakeHome }), join(links, "loop", "x"));
  assert.equal(assertScratch(join(scratch(), "fine"), { home: fakeHome }).endsWith("fine"), true);
});

test("hidden: open args are always hidden and -g/-n must come before --args", () => {
  const data = join(scratch(), "d");
  const args = hiddenOpenArgs({ app: "/tmp/b/Ardia WebUI.app", data, port: 9333, owner: "tok-1", env: { ARDIA_BACKGROUND: "0", EXTRA: "1" } });
  assert.deepEqual(args.slice(0, 2), ["-g", "-n"]);
  assert.ok(args.includes("ARDIA_BACKGROUND=1"));
  assert.ok(!args.includes("ARDIA_BACKGROUND=0"));
  assert.ok(args.includes(`${OWNER_SWITCH}=tok-1`));
  assert.equal(assertHidden(args), args);
  const envs = ["--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`];
  assert.throws(() => assertHidden([...envs, "/tmp/b/x.app", "--args", "-g", "-n"]), /-g before --args/);
  assert.throws(() => assertHidden(["-g", ...envs, "/tmp/b/x.app", "--args", "-n"]), /-n before --args/);
  assert.throws(() => assertHidden(["-g", "-n", "--env", `ARDIA_DATA_DIR=${data}`, "/tmp/b/x.app", "--args", "--env", "ARDIA_BACKGROUND=1"]), /ARDIA_BACKGROUND/);
  assert.throws(() => assertHidden(["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${join(HOME, "documents")}`, "/tmp/b/x.app"]), /refusing/);
  assert.throws(() => assertHidden(["-g", "-n", ...envs, "--env", "ARDIA_BACKGROUND=0", "/tmp/b/x.app"]), /ARDIA_BACKGROUND/);
  assert.throws(() => hiddenOpenArgs({ app: "/tmp/b/x.app", data, port: 1 }), /owner/);
});

test("hidden: cleanup only removes directories the harness created and marked", () => {
  const parent = scratch();
  const owned = makeOwnedRoot(parent);
  assert.ok(owned.root.startsWith(join(parent, "run-")));
  assert.ok(isOwnedDir(owned.root, owned.token));
  const dir = makeOwnedDir(owned, "rn-large-1");
  assert.throws(() => makeOwnedDir(owned, "rn-large-1"), /EEXIST/);
  assert.throws(() => makeOwnedDir(owned, "../escape"), /bad scratch name/);
  const foreign = join(parent, "someone-elses");
  mkdirSync(foreign);
  assert.equal(removeOwnedDir(foreign, owned.token), false);
  writeFileSync(join(foreign, OWNED_MARKER), "other-token");
  assert.equal(removeOwnedDir(foreign, owned.token), false);
  assert.ok(existsSync(foreign));
  assert.equal(removeOwnedDir(dir, owned.token), true);
  assert.ok(!existsSync(dir));
});

const PS = [
  "  100     1 Tue Nov 24 05:06:18 2026     /tmp/b/W.app/Contents/MacOS/W --ardia-shell=webui --ardia-bench-owner=tok-a",
  "  101   100 Tue Nov 24 05:06:19 2026     /tmp/b/W.app/Contents/Frameworks/Helper --type=renderer",
  "  102   101 Tue Nov 24 05:06:19 2026     /tmp/b/W.app/Contents/Frameworks/Helper --type=gpu",
  "  200     1 Tue Nov 24 05:06:20 2026     /usr/bin/grep --ardia-bench-owner=tok-a",
  "  300     1 Tue Nov 24 05:06:21 2026     /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-b",
].join("\n");

test("hidden: process identity needs the owner tag on the expected binary, plus its descendants", () => {
  const rows = parseProcessRows(PS);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].started, "Tue Nov 24 05:06:18 2026");
  const identity = processIdentity({ owner: "tok-a", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  assert.deepEqual(ownedTree(rows, identity).map((r) => r.pid), [100, 101, 102]);
  assert.deepEqual(ownedTree(rows, { ...identity, owner: "tok-c" }), []);
  assert.equal(sameProcess(rows[0], { ...rows[0] }), true);
  assert.equal(sameProcess(rows[0], { ...rows[0], started: "Wed Nov 25 01:00:00 2026" }), false);
  assert.equal(sameProcess(rows[0], { ...rows[0], command: "/bin/other" }), false);
});

test("hidden: stopping re-reads identity and reports a tree that will not exit", async () => {
  const identity = processIdentity({ owner: "tok-a", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const ghost = PS.replace(/^\s*100 /m, " 2147480001 ").replace(/^\s*101 /gm, " 2147480002 ").replace(/ 100 Tue/, " 2147480001 Tue");
  let reads = 0;
  const gone = await stopOwned(identity, { graceMs: 200, killMs: 200, read: () => (++reads <= 2 ? parseProcessRows(ghost) : []) });
  assert.equal(gone, true);
  const stuck = await stopOwned(identity, { graceMs: 50, killMs: 50, read: () => parseProcessRows(ghost) });
  assert.equal(stuck, false);
  assert.equal(await stopOwned(identity, { read: () => [] }), true);
});

test("hidden: a live owned process tree stops, an untagged sibling on the same binary survives", async () => {
  const keepAlive = ["-e", "setInterval(() => {}, 1000)"];
  const owned = spawn(process.execPath, [...keepAlive, "--", `${OWNER_SWITCH}=live-test-${process.pid}`], { stdio: "ignore" });
  const sibling = spawn(process.execPath, [...keepAlive, "--", "--not-owned"], { stdio: "ignore" });
  try {
    const identity = processIdentity({ owner: `live-test-${process.pid}`, binary: process.execPath });
    const deadline = Date.now() + 5000;
    let tree = ownedTree(readProcessRows(), identity);
    while (!tree.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      tree = ownedTree(readProcessRows(), identity);
    }
    assert.deepEqual(tree.map((r) => r.pid), [owned.pid]);
    assert.equal(await stopOwned(identity, { graceMs: 3000 }), true);
    assert.equal(ownedTree(readProcessRows(), identity).length, 0);
    assert.ok(readProcessRows().some((r) => r.pid === sibling.pid));
  } finally {
    owned.kill("SIGKILL");
    sibling.kill("SIGKILL");
  }
});

test("hidden: the cleanup registry keeps data while an instance is still alive", () => {
  const parent = scratch();
  const owned = makeOwnedRoot(parent);
  const dir = makeOwnedDir(owned, "x");
  const foreign = join(parent, "foreign");
  mkdirSync(foreign);
  const stuck = cleanupRegistry({ stopSync: () => false });
  stuck.instance({ owner: "a" });
  stuck.dir(dir, owned.token);
  stuck.dir(foreign, owned.token);
  stuck.runSync();
  assert.ok(existsSync(dir));
  const closed = [];
  const ok = cleanupRegistry({ stopSync: () => true });
  ok.instance({ owner: "a" });
  ok.dir(dir, owned.token);
  ok.dir(foreign, owned.token);
  ok.closer(() => closed.push(1));
  ok.runSync();
  ok.runSync();
  assert.deepEqual(closed, [1]);
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(foreign));
});

test("hidden: probes refuse a missing window instead of sending window null", async () => {
  const data = scratch();
  await assert.rejects(fileProbe(data, ACSWIPE, { op: "gesture", window: null }, 50), /no valid window/);
  await assert.rejects(fileProbe(data, ACSWIPE, { op: "gesture", window: 0 }, 50), /no valid window/);
  assert.ok(!existsSync(join(data, ACSWIPE.cmd)));
  await assert.rejects(fileProbe(data, ACSWIPE, { op: "untrace" }, 50), /within 50 ms/);
  assert.throws(() => validWindow(null), /no on-screen window/);
  assert.equal(validWindow(42), 42);
});

test("hidden: footprint and rss parsing", () => {
  assert.equal(parseFootprint("Chrome [1]: 64-bit\n  phys_footprint: 120 MB\nHelper [2]\n  phys_footprint: 512 KB\n"), 121);
  assert.equal(parseFootprint("blah\n  1.5 GB   TOTAL\n"), 1536);
  assert.equal(parseFootprint("nothing here"), null);
  assert.deepEqual([...parseRss(" 10 1024\n 11 2048\n junk\n")], [[10, 1024], [11, 2048]]);
});

test("cdp: a failed or slow handshake closes the socket", async () => {
  const made = [];
  class Failing {
    constructor() { made.push(this); this.closed = false; setTimeout(() => this.onerror?.(), 1); }
    close() { this.closed = true; }
  }
  class Silent {
    constructor() { made.push(this); this.closed = false; }
    close() { this.closed = true; }
  }
  await assert.rejects(openSocket("ws://x", { Socket: Failing }), /failed/);
  await assert.rejects(openSocket("ws://y", { Socket: Silent, timeoutMs: 20 }), /did not open/);
  assert.ok(made.every((s) => s.closed));
});

const fakeCdp = () => {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    send: async (method) => {
      sent.push(method);
      if (method === "Tracing.end") setTimeout(() => { for (const l of listeners) l({ method: "Tracing.tracingComplete" }); }, 1);
      return {};
    },
  };
};

test("cdp: a throwing traced action still ends the trace", async () => {
  const cdp = fakeCdp();
  await assert.rejects(traced(cdp, async () => { throw new Error("boom"); }, { warmupMs: 0, tailMs: 0 }), /boom/);
  assert.deepEqual(cdp.sent, ["Tracing.start", "Tracing.end"]);
  const ok = fakeCdp();
  const r = await traced(ok, async () => 7, { warmupMs: 0, tailMs: 0 });
  assert.equal(r.value, 7);
  assert.deepEqual(ok.sent, ["Tracing.start", "Tracing.end"]);
});

test("cdp: trace helpers align marks and screenshots", () => {
  const events = [
    { name: "Screenshot", ts: 2000, args: { snapshot: "b" } },
    { name: "Screenshot", ts: 1000, args: { snapshot: "a" } },
    { name: "Screenshot", ts: 3000, args: {} },
    { name: "ardia-bench-sync-x", cat: "blink.user_timing", ts: 500000 },
    { name: "ardia-pager-rest", cat: "blink,blink.user_timing", ts: 900000 },
  ];
  assert.deepEqual(screenshotsOf(events).map((e) => e.args.snapshot), ["a", "b"]);
  assert.equal(epochOffset(events, "ardia-bench-sync-x", 1_700_000_000_500), 1_700_000_000_000);
  assert.equal(epochOffset(events, "missing", 1), null);
  assert.deepEqual(marksOf(events, "ardia-pager").map((m) => m.name), ["ardia-pager-rest"]);
});

test("blocked swipe: the block is armed relative to dispatch and must overlap the motion", () => {
  const script = blockScript(150, 500);
  assert.match(script, /}, 150\);/);
  assert.match(script, /Date\.now\(\) - block\.start < 500/);
  assert.equal(overlapMs({ start: 100, end: 600 }, { start: 0, end: 400 }), 300);
  assert.equal(overlapMs({ start: 500, end: 1000 }, { start: 0, end: 400 }), 0);
  assert.equal(overlapMs({ start: 0, end: 100 }, { start: 100, end: 400 }), 0);
  assert.equal(overlapMs({ start: 0, end: null }, { start: 0, end: 1 }), null);
});

const run = (side, phase, extra) => ({ side, phase, status: "ok", errors: [], launchClock: "commitMark", newTabPollFailures: 0, ...extra });
const fixture = (phase) => {
  const f = expectedFixture({ small: smallSession, large: benchSession, multi: multiSession }[phase]());
  return { expected: f, restored: { ...f } };
};
const pace = (p95, max, late) => ({ p50GapMs: 8.3, p95GapMs: p95, maxGapMs: max, late120: late, moved: true });
const motionRuns = (side) => (side === "rn"
  ? { drag: pace(12, 30, 3), peek: { opened: true, dismissed: true, open: pace(12, 25, 2), dismiss: pace(12, 25, 2) } }
  : { drag: pace(9, 20, 1), peek: { opened: true, dismissed: true, open: pace(9, 18, 1), dismiss: pace(9, 18, 0) } });
const swipe = (p95, rest, rows) => ({
  fwd: { p95GapMs: p95, restMs: rest, blankFrames: 0, arrived: true },
  back: { p95GapMs: p95 - 5, restMs: rest + 10, rowsPaintedMs: rows, blankFrames: 0, arrived: true },
  blocked: { maxGapMs: 103, blankFrames: 0, arrived: true, blockOverlapMs: 350, motion: { start: 1000, end: 1500, source: "pager" }, block: { armedBy: "wheel", start: 1150, end: 1650 } },
});
const sampleRuns = () => {
  const runs = [];
  for (let rep = 0; rep < 3; rep++) {
    runs.push(run("rn", "small", { rep: rep + 1, launchMs: 500 + rep, memory: { rssMb: 900, footprintMb: 300 }, fixture: fixture("small") }));
    runs.push(run("webui", "small", { rep: rep + 1, launchMs: 580 + rep, memory: { rssMb: 770, footprintMb: 260 }, fixture: fixture("small") }));
    runs.push(run("rn", "large", { rep: rep + 1, ...motionRuns("rn"), launchMs: 514, newTabFrames: 0, memory: { rssMb: 966, footprintMb: 342 }, fixture: fixture("large"), swipe: swipe(50, 480, 200), scroll: { p95GapMs: 20, maxGapMs: 40 }, typing: { latenciesMs: [20, 22, 25, 30, 18, 21], missed: 0 } }));
    runs.push(run("webui", "large", { rep: rep + 1, ...motionRuns("webui"), launchMs: 588, newTabFrames: 0, memory: { rssMb: 823, footprintMb: 295 }, fixture: fixture("large"), swipe: swipe(37, 460, 0), scroll: { p95GapMs: 17, maxGapMs: 33 }, typing: { latenciesMs: [12, 14, 16, 15, 13, 20], missed: 0 } }));
    runs.push(run("rn", "multi", { rep: rep + 1, launchMs: 600, memory: { rssMb: 1100, footprintMb: 400 }, fixture: fixture("multi"), windows: 2, peek: true }));
    runs.push(run("webui", "multi", { rep: rep + 1, launchMs: 650, memory: { rssMb: 950, footprintMb: 350 }, fixture: fixture("multi"), windows: 2, peek: true }));
  }
  return runs;
};
const META = { host: "mini", reps: 3, order: "abab", phases: ["small", "large", "multi"], measures: ["launch", "memory", "swipe", "scroll", "typing", "drag", "peek"] };
const report = (runs = sampleRuns()) => ({ meta: META, runs, summary: summarizeRuns(runs) });
const edit = (pick, change) => sampleRuns().map((r, i, all) => (pick(r, i, all) ? change(structuredClone(r)) : r));
const failing = (result) => Object.fromEntries(result.rows.filter((r) => r.verdict !== "PASS").map((r) => [r.key, r]));

test("summary: per-side metrics roll up into median and p95", () => {
  const s = summarizeRuns(sampleRuns());
  assert.equal(s.rn["launch.small"].median, 501);
  assert.equal(s.webui["memory.large.footprintMb"].median, 295);
  assert.equal(s.webui["swipe.back.restMs"].median, 470);
  assert.equal(s.webui["swipe.blankFrames"].max, 0);
  assert.equal(s.webui["swipe.arrived"].median, 3);
  assert.equal(s.rn["typing.p95Ms"].median, 30);
});

test("summary: a failed swipe is never counted as zero blank frames", () => {
  const ok = (n) => ({ blankFrames: n, arrived: true });
  assert.equal(swipeBlankFrames({ fwd: ok(0), back: { error: "x" }, blocked: ok(0) }), null);
  assert.equal(swipeBlankFrames({ fwd: ok(1), back: ok(2) }), null);
  assert.equal(swipeBlankFrames({ fwd: ok(1), back: ok(2), blocked: ok(0) }), 3);
  assert.equal(swipeBlankFrames({ fwd: ok(1), back: ok(2) }, "rn"), 3);
  assert.equal(swipeBlankFrames({ fwd: ok(0), back: { blankFrames: 0, arrived: false }, blocked: ok(0) }), null);
  assert.equal(swipeBlankFrames({ fwd: ok(0), back: { blankFrames: 0 } }, "rn"), null);
  assert.deepEqual(swipesFor("rn"), ["fwd", "back"]);
  assert.deepEqual(swipesFor("webui"), ["fwd", "back", "blocked"]);
  const runs = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.swipe.back = { error: "selfrec did not start" }), r));
  const s = summarizeRuns(runs);
  assert.equal(s.webui["swipe.blankFrames"], undefined);
  assert.equal(s.webui["swipe.back.restMs"], undefined);
  const r = { swipe: { back: { error: "boom" } }, typing: { error: "keys" }, newTabPollFailures: 2 };
  assert.deepEqual(subErrors(r), ["swipe back: boom", "typing: keys", "2 New Tab polls failed"]);
  assert.equal(runStatus({ errors: subErrors(r) }), "partial");
  assert.equal(runStatus({ error: "x", errors: [] }), "error");
  assert.equal(runStatus({ errors: [] }), "ok");
});

test("gate: a WebUI at parity with clean integrity passes every rule", () => {
  const result = evaluate(report());
  assert.equal(result.verdict, "PASS", JSON.stringify(Object.values(failing(result))));
  assert.equal(result.rows.length, RULES.length + 10);
});

test("gate: integrity fails on missing, errored or partial reps", () => {
  const missing = sampleRuns().filter((r, i) => i !== 3);
  assert.ok(failing(evaluate(report(missing)))["integrity.runs"]);
  const errored = edit((r) => r.side === "rn" && r.phase === "small", (r) => ({ ...r, status: "error", error: "launch failed" }));
  const f = failing(evaluate(report(errored)));
  assert.ok(f["integrity.runs"] && f["integrity.errors"]);
  const partial = edit((r, i) => i === 3, (r) => ({ ...r, status: "partial", errors: ["scroll: boom"] }));
  assert.ok(failing(evaluate(report(partial)))["integrity.errors"]);
});

test("gate: integrity fails when a side restores a different fixture or skips 2 windows + Peek", () => {
  const short = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.fixture.restored.tabs = 169), r));
  assert.match(failing(evaluate(report(short)))["integrity.fixture"].why, /restored other/);
  const cross = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.fixture = { expected: { profiles: 3, tabs: 20, windows: 1 }, restored: { profiles: 3, tabs: 20, windows: 1 } }), r));
  assert.match(failing(evaluate(report(cross)))["integrity.fixture"].why, /runs seeded differently: large/);
  const noPeek = edit((r) => r.side === "webui" && r.phase === "multi", (r) => ((r.peek = false), r));
  assert.ok(failing(evaluate(report(noPeek)))["integrity.multi"]);
  const oneWindow = edit((r) => r.side === "rn" && r.phase === "multi", (r) => ((r.windows = 1), r));
  assert.ok(failing(evaluate(report(oneWindow)))["integrity.multi"]);
  const stuck = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.swipe.fwd.arrived = false), r));
  assert.ok(failing(evaluate(report(stuck)))["integrity.arrived"]);
});

test("gate: failed New Tab polls and mismatched launch clocks fail", () => {
  const polls = edit((r) => r.side === "webui" && r.phase === "small", (r) => ((r.newTabPollFailures = 4), r));
  assert.ok(failing(evaluate(report(polls)))["integrity.newTabPolls"]);
  const unrecorded = edit((r) => r.side === "rn" && r.phase === "small", (r) => (delete r.newTabPollFailures, r));
  assert.ok(failing(evaluate(report(unrecorded)))["integrity.newTabPolls"]);
  const mixed = edit((r) => r.side === "webui", (r) => ((r.launchClock = "fallback"), r));
  const row = failing(evaluate(report(mixed)))["integrity.clock"];
  assert.equal(row.rn, "commitMark");
  assert.equal(row.webui, "fallback");
  assert.equal(integrity(report(mixed), { allowFallbackClock: true }).find((r) => r.key === "integrity.clock").verdict, "PASS");
  const allFallback = edit(() => true, (r) => ((r.launchClock = "fallback"), r));
  assert.equal(integrity(report(allFallback)).find((r) => r.key === "integrity.clock").verdict, "PASS");
  const none = edit((r, i) => i === 0, (r) => ((r.launchClock = null), r));
  assert.ok(failing(evaluate(report(none), { allowFallbackClock: true }))["integrity.clock"]);
});

test("gate: the spike's slow settle and heavier memory fail with reasons", () => {
  const runs = edit((r) => r.side === "webui" && r.phase === "large", (r) => ({ ...r, memory: { rssMb: 1200, footprintMb: 400 }, swipe: { ...r.swipe, back: { ...r.swipe.back, restMs: 913 } } }));
  const f = failing(evaluate(report(runs)));
  assert.equal(f["swipe.back.restMs"].limit, 590);
  assert.match(f["swipe.back.restMs"].why, /913 > 590/);
  assert.ok(f["memory.large.footprintMb"] && f["memory.large.rssMb"]);
  assert.ok(!f["memory.small.rssMb"]);
});

test("gate: limits combine RN tolerance, budget and cap", () => {
  assert.equal(limitFor({ vsRn: true, tolerance: 100, budget: 500 }, 300), 500);
  assert.equal(limitFor({ vsRn: true, tolerance: 100, budget: 500 }, 490), 590);
  assert.equal(limitFor({ vsRn: true, tolerance: 150, cap: 1500 }, 1400), 1500);
  assert.equal(limitFor({ vsRn: false, cap: 0 }, null), 0);
  assert.equal(limitFor({ vsRn: true }, null), null);
});

test("gate: missing values fail unless allowed, budgets cover a missing RN side", () => {
  const r = { summary: { webui: { a: { median: 5 }, b: { median: 400 } }, rn: {} } };
  assert.equal(judge({ key: "a", vsRn: true }, r).verdict, "FAIL");
  assert.equal(judge({ key: "a", vsRn: true }, r, { allowMissing: true }).verdict, "SKIP");
  assert.equal(judge({ key: "zzz", vsRn: false, cap: 0 }, r).why, "WebUI value missing");
  assert.equal(judge({ key: "b", vsRn: true, budget: 500 }, r).why, "RN value missing");
  assert.equal(judge({ key: "b", vsRn: true, budget: 500, cap: 450 }, r).verdict, "PASS");
});

test("gate: baselines have no absolute deadband, define zero, and must hold the metric", () => {
  assert.equal(regressed(1.2, 1, 10), true);
  assert.equal(regressed(1.1, 1, 10), false);
  assert.equal(regressed(1, 0, 10), true);
  assert.equal(regressed(0, 0, 10), false);
  const rule = { key: "m", label: "m", vsRn: false };
  const now = (v) => ({ summary: { rn: {}, webui: { m: { median: v } } } });
  assert.equal(judge(rule, now(1.2), { baseline: now(1) }).verdict, "REGRESSION");
  assert.equal(judge(rule, now(0.3), { baseline: now(0) }).verdict, "REGRESSION");
  assert.match(judge(rule, now(0.3), { baseline: now(0) }).why, /baseline 0/);
  assert.equal(judge(rule, now(0), { baseline: now(0) }).verdict, "PASS");
  const empty = { summary: { rn: {}, webui: {} } };
  assert.equal(judge(rule, now(1), { baseline: empty }).verdict, "FAIL");
  assert.equal(judge(rule, now(1), { baseline: empty }).why, "baseline value missing");
  assert.equal(judge(rule, now(1), { baseline: empty, allowMissing: true }).verdict, "SKIP");
  const baseline = report();
  const runs = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.scroll.p95GapMs = 19), r));
  assert.equal(evaluate(report(runs), { baseline }).rows.find((x) => x.key === "scroll.p95GapMs").verdict, "REGRESSION");
});

test("gate: report, baseline and rule validation", () => {
  assert.deepEqual(validateReport(null), ["report is not a JSON object"]);
  assert.deepEqual(validateReport([]), ["report is not a JSON object"]);
  assert.ok(validateReport({ summary: { rn: {}, webui: {} } }).some((p) => p.includes("meta")));
  assert.deepEqual(validateReport(report()), []);
  assert.deepEqual(validateRules([]), ["rules must be a non-empty list"]);
  assert.deepEqual(validateRules({}), ["rules must be a non-empty list"]);
  assert.match(validateRules([{ key: "a" }])[0], /key and a label/);
  assert.match(validateRules([{ key: "a", label: "a", cap: "x" }])[0], /cap is not a number/);
  assert.deepEqual(validateRules(RULES), []);
});

test("gate: markdown table lists every row with a verdict", () => {
  const md = markdown(evaluate(report()), { meta: "mini, 3 reps" });
  const lines = md.trim().split("\n");
  assert.match(lines[0], /^## Mac WebUI parity gate: ✅ PASS$/);
  assert.ok(lines.includes("| Metric | RN | WebUI | Limit | Verdict |"));
  assert.ok(lines.includes("| --- | ---: | ---: | ---: | --- |"));
  const rows = lines.filter((l) => l.startsWith("| ") && !l.startsWith("| Metric") && !l.startsWith("| ---"));
  assert.equal(rows.length, RULES.length + 10);
  assert.ok(rows.every((l) => l.split(" | ").length === 5));
  assert.ok(md.includes("| Swipe Work → Personal, motion → rest (ms) | 490 | 470 | 590 | ✅ PASS |"));
  assert.ok(md.includes("| Integrity: launch clock | commitMark | commitMark | — | ✅ PASS |"));
  assert.match(lines.at(-1), /^\d+ passed, 0 failed, 0 skipped\.$/);
  assert.match(markdown(evaluate({ summary: { rn: {}, webui: {} } })), /❌ FAIL \(WebUI value missing\)/);
  assert.ok(markdown(evaluate(report(), { baseline: report() })).includes("| Baseline |"));
});

test("gate: the CLI exits 0 on PASS, 1 on FAIL, 64 on bad input", () => {
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value)), join(dir, name));
  const good = file("good.json", report());
  const empty = file("empty.json", { meta: META, runs: [], summary: { rn: {}, webui: {} } });
  const pass = node("gate.mjs", good, "--markdown", join(dir, "out.md"));
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /✅ PASS/);
  assert.equal(node("gate.mjs", empty).status, 1);
  assert.equal(node("gate.mjs", empty, "--allow-missing").status, 1);
  assert.equal(node("gate.mjs", file("null.json", "null")).status, 64);
  assert.equal(node("gate.mjs", file("arr.json", "[]")).status, 64);
  assert.equal(node("gate.mjs", file("shape.json", { summary: { rn: {}, webui: {} } })).status, 64);
  assert.equal(node("gate.mjs", good, "--baseline", file("bnull.json", "null")).status, 64);
  assert.equal(node("gate.mjs", good, "--rules", file("rules.json", [])).status, 64);
  assert.equal(node("gate.mjs", join(dir, "nope.json")).status, 64);
  assert.equal(node("gate.mjs", good, "--regression", "-1").status, 64);
  assert.equal(node("gate.mjs", "--help").status, 0);
  assert.equal(parseGateArgs(["r.json", "--allow-fallback-clock"]).allowFallbackClock, true);
});

test("round 2: a folder named ..bench inside a protected root is still inside it", () => {
  assert.equal(isInside("/a/..bench", "/a"), true);
  assert.equal(isInside("/a/b/..c/d", "/a/b"), true);
  assert.equal(isInside("/a", "/a/b"), false);
  assert.equal(isInside("/b", "/a"), false);
  assert.throws(() => assertScratch(join(HOME, "Documents", "..bench")), /refusing/);
  assert.throws(() => assertScratch(join(HOME, "Library", "..x", "y")), /refusing/);
  assert.throws(() => assertBuild("/Applications/..hidden/Ardia.app"), /installed/);
});

test("round 2: the RN app copy lives inside the run's own fresh folder", () => {
  const owned = makeOwnedRoot(scratch());
  const dir = rnCopyDir(owned.root);
  assert.ok(isInside(dir, owned.root));
  assert.notEqual(dir, join(dirname(owned.root), "apps", "rn"));
  assert.ok(!existsSync(dir));
});

test("round 2: a helper reparented to launchd is still tracked and stopped by pid and start time", async () => {
  const identity = processIdentity({ owner: "tok-a", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const ghost = (pid) => 2147480000 + pid;
  const line = (pid, ppid, started, command) => `${ghost(pid)} ${ppid === 1 ? 1 : ghost(ppid)} ${started} ${command}`;
  const T = "Tue Nov 24 05:06:18 2026";
  const before = parseProcessRows([line(100, 1, T, "/tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-a"), line(101, 100, T, "/tmp/b/W.app/Contents/Frameworks/Helper --type=gpu")].join("\n"));
  const orphaned = parseProcessRows(line(101, 1, T, "/tmp/b/W.app/Contents/Frameworks/Helper --type=gpu"));
  const reused = parseProcessRows(line(101, 1, "Wed Nov 25 09:00:00 2026", "/tmp/b/W.app/Contents/Frameworks/Helper --type=gpu"));
  assert.deepEqual(trackOwned(identity, before).map((r) => r.pid), [ghost(100), ghost(101)]);
  assert.deepEqual(ownedTree(orphaned, identity), []);
  assert.deepEqual(trackOwned(identity, orphaned).map((r) => r.pid), [ghost(101)]);
  assert.deepEqual(trackOwned(identity, reused), []);
  const signals = [];
  let reads = 0;
  const gone = await stopOwned(identity, { graceMs: 300, killMs: 300, read: () => (++reads <= 4 ? orphaned : []), kill: (pid, sig) => signals.push([pid, sig]) });
  assert.equal(gone, true);
  assert.deepEqual(signals, [[ghost(101), "SIGTERM"]]);
  const stuckSignals = [];
  assert.equal(await stopOwned(identity, { graceMs: 50, killMs: 50, read: () => orphaned, kill: (pid, sig) => stuckSignals.push(sig) }), false);
  assert.deepEqual(stuckSignals, ["SIGTERM", "SIGKILL"]);
  const reuseSignals = [];
  assert.equal(await stopOwned(identity, { read: () => reused, kill: (pid, sig) => reuseSignals.push(sig) }), true);
  assert.deepEqual(reuseSignals, []);
});

test("round 2: a failed teardown after a failed start surfaces as fatal, never swallowed", async () => {
  const start = new Error("no DevTools listener");
  await assert.rejects(teardownAfter(start, async () => {}), (e) => e === start);
  await assert.rejects(teardownAfter(start, async () => { throw new Error("instance x did not exit"); }), (e) => e.fatal === true && /no DevTools listener; teardown: instance x did not exit/.test(e.message) && e.cause === start);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.ok(!/finish\([^)]*\)\.catch\(/.test(source));
  assert.match(readFileSync(join(here, "../../lib/instance.mjs"), "utf8"), /if \(opts\.teardown\) \{\s*await opts\.teardown\(\);\s*throw e;/);
});

const waitFor = async (check, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
};

test("round 2: the block arms on the gesture itself and fires after the delay", async () => {
  const listeners = new Map();
  const saved = { add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  globalThis.addEventListener = (name, fn) => listeners.set(name, fn);
  globalThis.removeEventListener = (name) => listeners.delete(name);
  try {
    assert.equal(new Function(`return ${blockScript(5, 10)}`)(), 1);
    const block = globalThis.__ardiaBenchBlock;
    assert.equal(block.armedBy, null);
    assert.equal(await waitFor(() => block.start !== null, 30), false);
    listeners.get("wheel")();
    assert.equal(block.armedBy, "wheel");
    assert.ok(!listeners.has("wheel"));
    assert.ok(await waitFor(() => block.end !== null));
    assert.ok(block.start >= block.triggeredAt + 5);
    assert.ok(block.end - block.start >= 10);
    new Function(`return ${blockScript(0, 1)}`)();
    performance.mark("ardia-pager-moving");
    assert.ok(await waitFor(() => globalThis.__ardiaBenchBlock.armedBy === "pager"));
  } finally {
    globalThis.addEventListener = saved.add;
    globalThis.removeEventListener = saved.remove;
    delete globalThis.__ardiaBenchBlock;
  }
});

test("round 2: blocked-swipe overlap needs a measured motion interval", () => {
  const mark = (name, at) => ({ name, at });
  assert.equal(pagerMotion([]), null);
  assert.equal(pagerMotion([mark("ardia-pager-moving", 1000)]), null);
  assert.equal(pagerMotion([mark("ardia-pager-rest", 1500)]), null);
  assert.deepEqual(pagerMotion([mark("ardia-pager-moving", 1000), mark("ardia-pager-rest", 1500)]), { start: 1000, end: 1500, source: "pager" });
  const ran = { armedBy: "wheel", start: 1100, end: 1600 };
  assert.deepEqual(judgeBlock(ran, { start: 1000, end: 1400 }), { overlapMs: 300 });
  assert.match(judgeBlock(ran, null).error, /no paired ardia-pager-moving/);
  assert.match(judgeBlock({ ...ran, armedBy: null }, { start: 1000, end: 1400 }).error, /never armed/);
  assert.match(judgeBlock({ armedBy: "wheel", start: null, end: null }, { start: 1, end: 2 }).error, /never ran/);
  assert.match(judgeBlock({ armedBy: "pager", start: 2000, end: 2500 }, { start: 1000, end: 1400 }).error, /did not overlap/);
  assert.match(judgeBlock(null, { start: 1, end: 2 }).error, /never armed/);
});

test("round 2: the gate wants each rep exactly once and the same fixture in every run", () => {
  const fixed = sampleRuns();
  assert.equal(evaluate(report(fixed)).verdict, "PASS", JSON.stringify(Object.values(failing(evaluate(report(fixed))))));
  const twice = fixed.map((r) => (r.side === "webui" && r.phase === "large" && r.rep === 2 ? { ...r, rep: 1 } : r));
  const row = failing(evaluate(report(twice)))["integrity.runs"];
  assert.match(row.why, /webui large has reps \[1,1,3\], wants each of 1..3 once/);
  const third = fixed.map((r) => (r.side === "rn" && r.phase === "large" && r.rep === 3 ? { ...r, fixture: { expected: { profiles: 3, tabs: 20, windows: 1 }, restored: { profiles: 3, tabs: 20, windows: 1 } } } : r));
  assert.match(failing(evaluate(report(third)))["integrity.fixture"].why, /runs seeded differently: large/);
  const stray = [...fixed, { ...fixed[0], phase: "huge" }];
  assert.ok(failing(evaluate(report(stray)))["integrity.runs"]);
  const notArrived = fixed.map((r) => (r.side === "webui" && r.phase === "large" && r.rep === 2 ? { ...r, swipe: { ...r.swipe, back: { ...r.swipe.back, arrived: false } } } : r));
  const s = summarizeRuns(notArrived);
  assert.equal(s.webui["swipe.blankFrames"].n, 2);
  assert.ok(failing(evaluate(report(notArrived)))["integrity.arrived"]);
  const rnNoBlocked = fixed.map((r) => (r.side === "rn" && r.swipe ? { ...r, swipe: { fwd: r.swipe.fwd, back: r.swipe.back } } : r));
  assert.equal(evaluate(report(rnNoBlocked)).verdict, "PASS");
});

test("round 2: codesign and cp in the app copier have finite timeouts", () => {
  const source = readFileSync(join(here, "../../lib/app-copy.mjs"), "utf8");
  const calls = source.split("\n").filter((l) => /(?:spawnSync|execFileSync)\("(?:codesign|cp)"/.test(l));
  assert.ok(calls.length >= 6);
  for (const call of calls) assert.match(call, /timeout: (?:CODESIGN|COPY)_TIMEOUT_MS/, call);
});

test("round 2: null runs and bad rule types are rejected with exit 64", () => {
  const good = report();
  assert.ok(validateReport({ ...good, runs: [null] }).some((p) => p.includes("runs[0] is not an object")));
  assert.ok(validateReport({ ...good, runs: [{ side: "ios", phase: "large", rep: 1 }] }).some((p) => p.includes("runs[0] needs side")));
  assert.ok(validateReport({ ...good, runs: [{ side: "rn", phase: "large", rep: 0 }] }).some((p) => p.includes("runs[0] needs side")));
  assert.match(validateRules([{ key: "a", label: "a", vsRn: "yes" }])[0], /vsRn is not true or false/);
  assert.match(validateRules([{ key: "a", label: "a", stat: "p99" }])[0], /stat is not one of median, p95, max/);
  assert.deepEqual(validateRules([{ key: "a", label: "a", vsRn: false, stat: "max" }]), []);
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), JSON.stringify(value)), join(dir, name));
  assert.equal(node("gate.mjs", file("nullrun.json", { ...good, runs: [...good.runs, null] })).status, 64);
  assert.equal(node("gate.mjs", file("g.json", good), "--rules", file("r.json", [{ key: "a", label: "a", stat: "p99" }])).status, 64);
  assert.equal(node("gate.mjs", file("g2.json", good), "--rules", file("r2.json", [{ key: "a", label: "a", vsRn: 1 }])).status, 64);
});

test("round 3: launch routes a failed readiness check to the teardown hook and snapshots owners early", () => {
  const source = readFileSync(join(here, "../../lib/instance.mjs"), "utf8");
  assert.match(source, /if \(opts\.teardown\) \{\s*opts\.track\?\.\(\);\s*await opts\.teardown\(\);\s*\} else await instance\.quit\(\{ graceful: false \}\);/);
  assert.match(source, /; await sleep\(100\)\) \{\s*opts\.track\?\.\(\);/);
  assert.match(source, /within \$\{\(opts\.startTimeout \?\? 60000\) \/ 1000\} s \(log: \$\{log\}\)`\);\s*opts\.track\?\.\(\);/);
  const bench = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.match(bench, /track: \(\) => this\.track\(\{ identity \}\),\s*teardown:/);
});

test("round 3: a snapshot taken at startup keeps a helper that is reparented before teardown", async () => {
  const identity = processIdentity({ owner: "tok-r3", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const T = "Tue Nov 24 05:06:18 2026";
  const startup = parseProcessRows([`2147481100 1 ${T} /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-r3`, `2147481101 2147481100 ${T} /tmp/b/W.app/Contents/Frameworks/Helper --type=gpu`].join("\n"));
  const afterQuit = parseProcessRows(`2147481101 1 ${T} /tmp/b/W.app/Contents/Frameworks/Helper --type=gpu`);
  trackOwned(identity, startup);
  const signals = [];
  let reads = 0;
  assert.equal(await stopOwned(identity, { graceMs: 300, killMs: 300, read: () => (++reads <= 4 ? afterQuit : []), kill: (pid, sig) => signals.push([pid, sig]) }), true);
  assert.deepEqual(signals, [[2147481101, "SIGTERM"]]);
  const blind = processIdentity({ owner: "tok-r3", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const missed = [];
  await stopOwned(blind, { graceMs: 50, killMs: 50, read: () => afterQuit, kill: (pid, sig) => missed.push(sig) });
  assert.deepEqual(missed, []);
});

test("round 3: unrelated sidebar repaints cannot prove the block overlapped the swipe", () => {
  const block = { armedBy: "wheel", start: 1200, end: 1700 };
  const repaintsOnly = [];
  assert.equal(pagerMotion(repaintsOnly, 1000), null);
  assert.match(judgeBlock(block, pagerMotion(repaintsOnly, 1000)).error, /no paired ardia-pager-moving/);
  const stoppedEarly = [{ name: "ardia-pager-moving", at: 1000 }, { name: "ardia-pager-rest", at: 1050 }];
  assert.deepEqual(pagerMotion(stoppedEarly, 1000), { start: 1000, end: 1050, source: "pager" });
  assert.match(judgeBlock(block, pagerMotion(stoppedEarly, 1000)).error, /did not overlap/);
  const stale = [{ name: "ardia-pager-moving", at: 400 }, { name: "ardia-pager-rest", at: 1500 }];
  assert.equal(pagerMotion(stale, 1000), null);
  const paired = [{ name: "ardia-pager-rest", at: 900 }, { name: "ardia-pager-moving", at: 1100 }, { name: "ardia-pager-rest", at: 1600 }, { name: "ardia-pager-rest", at: 2400 }];
  assert.deepEqual(pagerMotion(paired, 1000), { start: 1100, end: 1600, source: "pager" });
  assert.deepEqual(judgeBlock(block, pagerMotion(paired, 1000)), { overlapMs: 400 });
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.match(source, /const motion = pagerMotion\(cap\.marks, cap\.value\);/);
});

test("round 3: launch clocks, huge rep counts and empty fixtures are rejected", () => {
  const good = report();
  const withRun = (patch) => ({ ...good, runs: [{ ...good.runs[0], ...patch }, ...good.runs.slice(1)] });
  assert.ok(validateReport(withRun({ launchClock: { kind: "commitMark" } })).some((p) => p.includes("launchClock")));
  assert.ok(validateReport(withRun({ launchClock: "wallclock" })).some((p) => p.includes("launchClock")));
  assert.deepEqual(validateReport(withRun({ launchClock: "fallback" })), []);
  assert.ok(validateReport({ ...good, meta: { ...good.meta, reps: 4294967296 } }).some((p) => p.includes("meta.reps")));
  assert.ok(validateReport({ ...good, meta: { ...good.meta, reps: 10001 } }).some((p) => p.includes("meta.reps")));
  assert.ok(validateReport({ ...good, meta: { ...good.meta, reps: 2.5 } }).some((p) => p.includes("meta.reps")));
  const huge = { ...good, meta: { ...good.meta, reps: 4294967296 } };
  const result = evaluate(huge);
  assert.equal(result.rows.find((r) => r.key === "integrity.runs").verdict, "FAIL");
  assert.ok(validateReport(withRun({ fixture: { expected: {}, restored: {} } })).some((p) => p.includes("fixture.expected")));
  assert.ok(validateReport(withRun({ fixture: { expected: { profiles: 3, tabs: 3, windows: 1 }, restored: { profiles: 3, tabs: -1, windows: 1 } } })).some((p) => p.includes("fixture.restored")));
  assert.ok(validateReport(withRun({ fixture: "yes" })).some((p) => p.includes("fixture is not an object")));
  const empty = good.runs.map((r) => ({ ...r, fixture: { expected: {}, restored: {} } }));
  assert.ok(failing(evaluate({ ...good, runs: empty }))["integrity.fixture"]);
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), JSON.stringify(value)), join(dir, name));
  assert.equal(node("gate.mjs", file("clock.json", withRun({ launchClock: {} }))).status, 64);
  assert.equal(node("gate.mjs", file("reps.json", { ...good, meta: { ...good.meta, reps: 4294967296 } })).status, 64);
  assert.equal(node("gate.mjs", file("fixture.json", withRun({ fixture: { expected: {}, restored: {} } }))).status, 64);
  assert.equal(node("gate.mjs", file("ok.json", good)).status, 0);
});

test("round 4: the startup tracker keeps polling, so a helper spawned between discovery and readiness is owned", async () => {
  const identity = processIdentity({ owner: "tok-r4", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const T = "Tue Nov 24 05:06:18 2026";
  const root = `2147482100 1 ${T} /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-r4`;
  const helper = (ppid) => `2147482101 ${ppid} ${T} /tmp/b/W.app/Contents/Frameworks/Helper --type=renderer`;
  const frames = [[root], [root], [root, helper(2147482100)], [helper(1)]];
  let reads = 0;
  const stop = startTracker(identity, { everyMs: 5, read: () => parseProcessRows(frames[Math.min(reads++, frames.length - 1)].join("\n")) });
  assert.ok(await waitFor(() => reads >= frames.length, 2000));
  stop();
  const after = reads;
  assert.ok(await waitFor(() => reads > after, 40) === false);
  assert.deepEqual([...identity.seen.values()].map((r) => r.pid).sort(), [2147482100, 2147482101]);
  assert.deepEqual(trackOwned(identity, parseProcessRows(helper(1))).map((r) => r.pid), [2147482101]);
  const signals = [];
  let left = 3;
  assert.equal(await stopOwned(identity, { graceMs: 300, killMs: 300, read: () => parseProcessRows(left-- > 0 ? helper(1) : ""), kill: (pid, sig) => signals.push([pid, sig]) }), true);
  assert.deepEqual(signals, [[2147482101, "SIGTERM"]]);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.equal(source.match(/const stopTracking = startTracker\(identity\);/g)?.length, 2);
  assert.equal(source.match(/\} finally \{\s*stopTracking\(\);\s*\}/g)?.length, 2);
});

test("round 4: a completed run needs both expected and restored fixture counts", () => {
  const counts = { profiles: 3, tabs: 3, windows: 1 };
  assert.equal(fixtureProblem({}, { completed: true }), "fixture.expected needs integer profiles, tabs and windows ≥ 0");
  assert.equal(fixtureProblem({ expected: counts }, { completed: true }), "fixture.restored needs integer profiles, tabs and windows ≥ 0");
  assert.equal(fixtureProblem(undefined, { completed: true }), "is completed but has no fixture");
  assert.equal(fixtureProblem({ expected: counts, restored: counts }, { completed: true }), null);
  assert.equal(fixtureProblem({ expected: counts }), null);
  const good = report();
  const withFirst = (patch) => ({ ...good, runs: [{ ...good.runs[0], ...patch }, ...good.runs.slice(1)] });
  assert.ok(validateReport(withFirst({ fixture: {} })).some((p) => p.includes("fixture.expected")));
  assert.ok(validateReport(withFirst({ fixture: { expected: counts } })).some((p) => p.includes("fixture.restored")));
  assert.deepEqual(validateReport(withFirst({ status: "error", error: "x", fixture: { expected: counts } })), []);
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), JSON.stringify(value)), join(dir, name));
  assert.equal(node("gate.mjs", file("empty-fixture.json", withFirst({ fixture: {} }))).status, 64);
  assert.equal(node("gate.mjs", file("half-fixture.json", withFirst({ fixture: { expected: counts } }))).status, 64);
  assert.equal(node("gate.mjs", file("no-fixture.json", withFirst({ fixture: undefined }))).status, 64);
});

test("round 5: the tracker keeps ticking while an async open runs, so a helper whose root exits first is still owned", async () => {
  const T = "Tue Nov 24 05:06:18 2026";
  const root = `2147483100 1 ${T} /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-r5`;
  const helper = (ppid) => `2147483101 ${ppid} ${T} /tmp/b/W.app/Contents/Frameworks/Helper --type=gpu`;
  const timeline = (started) => () => {
    const t = Date.now() - started;
    const rows = t < 20 ? [] : t < 45 ? [root] : t < 70 ? [root, helper(2147483100)] : [helper(1)];
    return parseProcessRows(rows.join("\n"));
  };
  const asyncLaunch = processIdentity({ owner: "tok-r5", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  let started = Date.now();
  await withTracker(asyncLaunch, () => new Promise((done) => setTimeout(done, 110)), { everyMs: 5, read: timeline(started) });
  assert.deepEqual([...asyncLaunch.seen.values()].map((r) => r.pid).sort(), [2147483100, 2147483101]);
  assert.deepEqual(trackOwned(asyncLaunch, parseProcessRows(helper(1))).map((r) => r.pid), [2147483101]);
  const blockingLaunch = processIdentity({ owner: "tok-r5", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  started = Date.now();
  await withTracker(blockingLaunch, () => {
    const until = Date.now() + 110;
    while (Date.now() < until);
  }, { everyMs: 5, read: timeline(started) });
  assert.deepEqual([...blockingLaunch.seen.values()], []);
  const instance = readFileSync(join(here, "../../lib/instance.mjs"), "utf8");
  assert.match(instance, /await new Promise\(\(done, fail\) => execFile\("open", openArgs/);
  assert.ok(!/execFileSync\("open"/.test(instance));
  const bench = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.match(bench, /await execFileAsync\("open", args/);
  assert.ok(!/execFileSync\("open"/.test(bench));
});

test("round 5: a stall that starts during motion and lands after the rest mark still fails the blocked swipe", () => {
  const times = [0, 16, 32, 48, 64, 80, 96, 600, 616];
  const frames = times.map((_, i) => pattern(i));
  const r = analyze({ frames, times, start: 0, rest: 300 });
  assert.equal(r.maxGapMs, 504);
  assert.ok(r.longGaps >= 1);
  assert.ok(r.late120 >= 1);
  const verdict = judge(RULES.find((x) => x.key === "swipe.blocked.maxGapMs"), { summary: { rn: {}, webui: { "swipe.blocked.maxGapMs": { median: r.maxGapMs } } } });
  assert.equal(verdict.verdict, "FAIL");
  assert.deepEqual(windowGaps([-800, 5, 21], 0, 300), [5, 16]);
  assert.deepEqual(windowGaps([100, 200, 900, 950], 0, 300), [100, 100, 700]);
  assert.deepEqual(windowGaps([400, 500], 0, 300), [400]);
  assert.equal(LATE_120_MS, 12.5);
});

test("round 5: divider drag and Peek pacing run, summarize and gate against RN", () => {
  assert.ok(MEASURES.includes("drag") && MEASURES.includes("peek"));
  const out = scratch();
  const plan = planBench(parseBenchArgs(["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out, "--reps", "1", "--only", "drag,peek", "--dry-run"]));
  assert.deepEqual(plan.measures, ["drag", "peek"]);
  assert.deepEqual(plan.phases, ["large"]);
  const s = summarizeRuns(sampleRuns());
  assert.equal(s.webui["drag.late120"].median, 1);
  assert.equal(s.rn["peek.open.p95GapMs"].median, 12);
  assert.equal(s.webui["peek.dismiss.maxGapMs"].median, 18);
  const keys = RULES.map((r) => r.key);
  for (const k of ["drag.p95GapMs", "drag.maxGapMs", "drag.late120", "peek.open.p95GapMs", "peek.open.late120", "peek.dismiss.p95GapMs", "peek.dismiss.late120"]) assert.ok(keys.includes(k), k);
  const janky = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.drag = pace(30, 90, 20)), r));
  const f = failing(evaluate(report(janky)));
  assert.ok(f["drag.p95GapMs"] && f["drag.maxGapMs"] && f["drag.late120"]);
  const stuck = edit((r) => r.side === "rn" && r.phase === "large" && r.rep === 2, (r) => ((r.peek = { ...r.peek, dismissed: false, error: "the Peek did not go away" }), r));
  assert.ok(failing(evaluate(report(stuck)))["integrity.peek"]);
  assert.deepEqual(subErrors({ peek: { error: "no" }, drag: { error: "still" } }), ["peek: no", "drag: still"]);
  const missing = edit((r) => r.side === "webui" && r.phase === "large", (r) => (delete r.drag, r));
  assert.match(failing(evaluate(report(missing)))["drag.p95GapMs"].why, /WebUI value missing/);
});

test("round 6: the fallback launch clock is when the window appeared, not when readiness or DevTools finished", async () => {
  const identity = processIdentity({ owner: "tok-r6", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const T = "Tue Nov 24 05:06:18 2026";
  trackOwned(identity, parseProcessRows(`2147483200 1 ${T} /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-r6`));
  assert.equal(ownerRootPid(identity), 2147483200);
  const t0 = Date.now();
  const watch = watchFirstWindow({ rootPid: () => ownerRootPid(identity), everyMs: 5, listWindows: async () => (Date.now() - t0 >= 40 ? [{ layer: 0, w: 1360, h: 820 }] : [{ layer: 25, w: 1360, h: 820 }]) });
  assert.ok(await waitFor(() => watch.at != null, 1000));
  const timing = await firstWindowTiming({ t0, commitMark: () => null, windowAt: () => watch.at, timeoutMs: 100 });
  watch.stop();
  assert.equal(timing.launchClock, "fallback");
  assert.ok(timing.launchMs >= 40 && timing.launchMs < 150, `launchMs ${timing.launchMs}`);
  assert.equal(timing.windowMs, timing.launchMs);
  const marked = await firstWindowTiming({ t0: 1000, commitMark: () => 1514, windowAt: () => 1600, timeoutMs: 100 });
  assert.deepEqual(marked, { launchMs: 514, launchClock: "commitMark", windowMs: 600 });
  assert.deepEqual(await firstWindowTiming({ t0: 0, commitMark: () => { throw new Error("no page"); }, windowAt: () => null, timeoutMs: 30, everyMs: 5 }), { launchMs: null, launchClock: null, windowMs: null });
  assert.equal(isMainWindow({ layer: 0, w: 1360, h: 820 }), true);
  assert.equal(isMainWindow({ layer: 25, w: 1360, h: 820 }), false);
  assert.equal(isMainWindow({ layer: 0, w: 40, h: 40 }), false);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.equal(source.match(/this\.watchWindow\(identity\)/g)?.length, 2);
});

test("round 6: paired scenarios run on Personal and the blocked swipe runs after them", () => {
  assert.equal(PAIRED_PROFILE, "default");
  assert.deepEqual(scenarioOrder("webui", MEASURES), ["scroll", "typing", "peek", "drag", "blocked"]);
  assert.deepEqual(scenarioOrder("rn", MEASURES), ["scroll", "typing", "peek", "drag"]);
  assert.deepEqual(scenarioOrder("webui", ["swipe"]), ["blocked"]);
  assert.deepEqual(scenarioOrder("webui", ["typing", "scroll"]), ["scroll", "typing"]);
  assert.deepEqual(subErrors({ phase: "large", pairedProfile: "work" }), ["paired scenarios ran on work, not default"]);
  assert.deepEqual(subErrors({ phase: "large", pairedProfile: null }), ["paired scenarios ran on an unknown profile, not default"]);
  assert.deepEqual(subErrors({ phase: "large", pairedProfile: "default" }), []);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  const measure = source.slice(source.indexOf("  async measure("), source.indexOf("  async slot("));
  assert.ok(measure.indexOf("run.pairedProfile = await side.js(PROFILE)") < measure.indexOf("for (const step of scenarioOrder"));
  assert.ok(!/run\.swipe\.blocked = await sample\(\(\) => this\.swipe\(side, win, "blocked"\)\);\n\s*if \(o\.only\.includes\("typing"\)\)/.test(measure));
});

test("round 6: the drag aims at the seeded sidebarWidth and must change it", () => {
  assert.equal(SETTINGS.sidebarWidth, 260);
  for (const make of [benchSession, smallSession, multiSession]) assert.equal(make().settings.sidebarWidth, 260);
  assert.deepEqual(DRAG_EDGE_OFFSETS, [0, 4, 8, 12]);
  assert.equal(dragChanged(260, 380), true);
  assert.equal(dragChanged(260, 320), true);
  assert.equal(dragChanged(260, 319), false);
  assert.equal(dragChanged(260, 260), false);
  assert.equal(dragChanged(null, 380), false);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  const drag = source.slice(source.indexOf("  async drag("), source.indexOf("  async peek("));
  assert.match(drag, /const x0 = bounds\.x \+ before \+ offset;/);
  assert.match(drag, /if \(dragChanged\(before, after\)\)/);
  assert.ok(!drag.includes("SIDEBAR_FALLBACK"));
});

test("round 6: Peek is dismissed with Esc, the animated path, and timed until it is gone", async () => {
  let checks = 0;
  const gone = await waitGone(async () => ++checks < 4, { timeoutMs: 1000, everyMs: 5 });
  assert.ok(Number.isFinite(gone));
  assert.equal(checks, 4);
  assert.equal(await waitGone(async () => true, { timeoutMs: 30, everyMs: 5 }), null);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  const peek = source.slice(source.indexOf("  async peek("), source.indexOf("  async typing("));
  const dismiss = peek.slice(peek.indexOf('"peek-dismiss"'));
  assert.match(dismiss, /"postkeys", String\(side\.pid\), "0", "esc"/);
  assert.match(dismiss, /await waitGone\(\(\) => exists\(peekId\)/);
  assert.ok(!dismiss.includes("closePeek"));
  assert.ok(dismiss.lastIndexOf("await cleanUp()") > dismiss.indexOf("if (!result.dismissed)"));
});

test("round 6: a missing footprint fails the run and the gate", () => {
  assert.deepEqual(footprintResult({ status: 0, stdout: "  12 MB  TOTAL\n" }), { footprintMb: 12 });
  assert.match(footprintResult({ status: null, error: { code: "ETIMEDOUT" } }).error, /ETIMEDOUT/);
  assert.match(footprintResult({ status: 1, stdout: "" }).error, /exited 1/);
  assert.match(footprintResult({ status: 0, stdout: "garbage" }).error, /no total/);
  assert.deepEqual(subErrors({ memory: { rssMb: 900, footprintMb: null, error: "footprint exited 1" } }), ["memory: footprint exited 1"]);
  assert.deepEqual(subErrors({ memory: { rssMb: 900, footprintMb: null } }), ["memory: incomplete sample"]);
  const twoOfThree = edit((r) => r.side === "webui" && r.phase === "small" && r.rep !== 2, (r) => ((r.memory = { rssMb: 770, footprintMb: null }), r));
  const f = failing(evaluate(report(twoOfThree)));
  assert.ok(f["integrity.memory"]);
  assert.equal(f["integrity.memory"].webui, 2);
  assert.equal(failing(evaluate(report()))["integrity.memory"], undefined);
});

test("review 2: window timing is watched from before open and New Tab polls start before the fixture read", () => {
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  for (const start of ["  async startRn(", "  async startWebui("]) {
    const body = source.slice(source.indexOf(start), source.indexOf("\n  }\n", source.indexOf(start)));
    const watch = body.indexOf("this.watchWindow(identity)");
    const open = Math.max(body.indexOf("await launch("), body.indexOf('await execFileAsync("open"'));
    assert.ok(watch > 0 && open > watch, `${start} watches windows before it opens the app`);
  }
  const measure = source.slice(source.indexOf("  async measure("), source.indexOf("  async slot("));
  const first = measure.indexOf("await this.firstWindow(side)");
  const polls = measure.indexOf("await this.newTabPolls(side");
  const fixture = measure.indexOf("run.fixture = ");
  assert.ok(first < polls && polls < fixture);
  assert.match(source, /const newTabPollStartMs = Date\.now\(\) - side\.t0;/);
  assert.match(source, /newTabPolls: NEW_TAB_POLLS, newTabPollStartMs \}/);
});

test("review 3: the RN selfrec folder exists before launch, so a mkdir failure can never strand a running app", () => {
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  const body = source.slice(source.indexOf("  async startRn("), source.indexOf("  async startWebui("));
  const mkdir = body.indexOf('mkdirSync(join(data, "selfrec")');
  assert.equal(body.split('mkdirSync(join(data, "selfrec")').length - 1, 1);
  assert.ok(mkdir > 0 && mkdir < body.indexOf("startTracker(identity)") && mkdir < body.indexOf("await launch("));
});

test("review 4: a Peek transition needs changed frames, not only store state", () => {
  const good = { moved: true, pacingComplete: true, p95GapMs: 9 };
  assert.equal(pacingProblem(good, "Peek open"), null);
  assert.equal(pacingProblem({ ...good, moved: false }, "Peek open"), "Peek open produced no changed frame");
  assert.equal(pacingProblem({ ...good, moved: false }, "Peek dismiss"), "Peek dismiss produced no changed frame");
  assert.equal(pacingProblem({ ...good, pacingComplete: false }, "Peek open"), "the Peek open capture began after the motion started");
  assert.equal(pacingProblem(undefined, "Peek dismiss"), "Peek dismiss has no frame pacing");
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  const peek = source.slice(source.indexOf("  async peek("), source.indexOf("  async typing("));
  assert.match(peek, /pacingProblem\(result\.open, "Peek open"\)/);
  assert.match(peek, /pacingProblem\(result\.dismiss, "Peek dismiss"\)/);
});

test("review 5: a trace that lost data rejects the sample", async () => {
  const lossy = fakeCdp();
  const send = lossy.send;
  const listeners = [];
  lossy.on = (l) => (listeners.push(l), () => {});
  lossy.send = async (method) => {
    if (method === "Tracing.end") setTimeout(() => listeners.forEach((l) => l({ method: "Tracing.tracingComplete", params: { dataLossOccurred: true } })), 1);
    return send(method);
  };
  const trace = await traced(lossy, async () => 1, { warmupMs: 0, tailMs: 0 });
  assert.equal(trace.dataLoss, true);
  assert.throws(() => assertTraceComplete(trace, "swipe-fwd"), /swipe-fwd trace lost data/);
  const clean = await traced(fakeCdp(), async () => 1, { warmupMs: 0, tailMs: 0 });
  assert.equal(clean.dataLoss, false);
  assert.equal(assertTraceComplete(clean), clean);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.match(source, /assertTraceComplete\(await traced\(side\.cdp,/);
});

test("review 6: the wait from motion start to the first changed frame counts, and a late capture is incomplete", () => {
  const frames = [pattern(0), pattern(0), pattern(1), pattern(2)];
  const covered = analyze({ frames, times: [-20, 10, 300, 316], start: 0, rest: 400 });
  assert.equal(covered.maxGapMs, 300);
  assert.equal(covered.newFrames, 2);
  assert.equal(covered.pacingComplete, true);
  const late = analyze({ frames: [pattern(0), pattern(1), pattern(2)], times: [120, 300, 316], start: 0, rest: 400 });
  assert.equal(late.pacingComplete, false);
  assert.equal(late.maxGapMs, 16);
  assert.equal(pacingProblem({ ...late, moved: true }, "divider drag"), "the divider drag capture began after the motion started");
  assert.equal(analyze({ frames, times: [0, 10, 20, 30] }).pacingComplete, true);
  assert.deepEqual(windowGaps([300, 316], 0, 400, { coversStart: false }), [16]);
  assert.deepEqual(windowGaps([300, 316], 0, 400), [300, 16]);
});

test("review 7: a cap alone never stands in for RN evidence", () => {
  const only = (v) => ({ summary: { rn: {}, webui: { m: { median: v } } } });
  assert.equal(judge({ key: "m", label: "m", vsRn: true, cap: 1500 }, only(600)).why, "RN value missing");
  assert.equal(judge({ key: "m", label: "m", vsRn: true, budget: 500 }, only(400)).why, "RN value missing");
  assert.equal(judge({ key: "m", label: "m", vsRn: true, budget: 500, cap: 600 }, only(400)).verdict, "PASS");
  assert.equal(judge({ key: "m", label: "m", vsRn: true, budget: 500, cap: 600 }, only(550)).why, "RN value missing");
  assert.equal(judge({ key: "m", label: "m", vsRn: false, cap: 0 }, only(0)).verdict, "PASS");
});

test("review 8: the gate re-proves each blocked swipe from its pager interval and block", () => {
  const ok = { arrived: true, motion: { start: 1000, end: 1500 }, block: { start: 1150, end: 1650 } };
  assert.equal(blockedProblem(ok), null);
  assert.equal(blockedProblem({ ...ok, motion: null }), "no pager moving → rest interval");
  assert.equal(blockedProblem({ ...ok, motion: { start: 1000, end: 1000 } }), "no pager moving → rest interval");
  assert.equal(blockedProblem({ ...ok, block: { start: null, end: null } }), "no recorded block interval");
  assert.equal(blockedProblem({ ...ok, block: { start: 1600, end: 2100 } }), "the block did not overlap the pager motion");
  assert.equal(blockedProblem({ ...ok, arrived: false }), "did not arrive");
  const forged = edit((r) => r.side === "webui" && r.phase === "large" && r.rep === 2, (r) => ((r.swipe.blocked = { maxGapMs: 103, blankFrames: 0, arrived: true, blockOverlapMs: 300 }), r));
  const row = failing(evaluate(report(forged)))["integrity.blocked"];
  assert.equal(row.webui, 1);
  assert.equal(row.rn, null);
  assert.equal(evaluate(report()).rows.find((r) => r.key === "integrity.blocked").verdict, "PASS");
});

test("review 9: an incomplete baseline is refused before anything is compared", () => {
  const good = report();
  assert.deepEqual(baselineProblems(good), []);
  const broken = report(sampleRuns().filter((r, i) => i !== 0));
  const problems = baselineProblems(broken);
  assert.ok(problems.some((p) => p.startsWith("baseline Integrity: finished runs")));
  assert.deepEqual(baselineProblems(null), ["baseline is not a JSON object"]);
  const row = evaluate(good, { baseline: broken }).rows.find((r) => r.key === "integrity.baseline");
  assert.equal(row.verdict, "FAIL");
  assert.equal(evaluate(good, { baseline: good }).rows.find((r) => r.key === "integrity.baseline").verdict, "PASS");
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), JSON.stringify(value)), join(dir, name));
  const cli = node("gate.mjs", file("now.json", good), "--baseline", file("then.json", broken));
  assert.equal(cli.status, 64);
  assert.match(cli.stderr, /baseline Integrity: finished runs/);
  assert.equal(node("gate.mjs", file("now2.json", good), "--baseline", file("then2.json", good)).status, 0);
});

test("review 10: a process that shows up only on the second read is still signalled and counted", () => {
  const identity = processIdentity({ owner: "tok-r10", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const T = "Tue Nov 24 05:06:18 2026";
  const appeared = parseProcessRows(`2147483300 1 ${T} /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-r10`);
  const reads = [[], appeared];
  const signals = [];
  assert.equal(signalOwned(identity, "SIGTERM", () => reads.shift() ?? [], (pid, sig) => signals.push([pid, sig])), 1);
  assert.deepEqual(signals, [[2147483300, "SIGTERM"]]);
  const quiet = [];
  assert.equal(signalOwned(processIdentity({ owner: "tok-none", binary: "/tmp/b/W.app/Contents/MacOS/W" }), "SIGTERM", () => [], (pid) => quiet.push(pid)), 0);
  assert.deepEqual(quiet, []);
});

test("review 11: a Peek capture that throws closes the Peek before the error propagates", async () => {
  const calls = [];
  const orClose = captureOrClose(async () => calls.push("closePeek"));
  const lost = new Error("the peek-dismiss trace lost data");
  await assert.rejects(orClose(async () => {
    calls.push("capture");
    throw lost;
  }), (e) => e === lost);
  assert.deepEqual(calls, ["capture", "closePeek"]);
  calls.length = 0;
  assert.equal(await orClose(async () => (calls.push("capture"), 7)), 7);
  assert.deepEqual(calls, ["capture"]);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  const peek = source.slice(source.indexOf("  async peek("), source.indexOf("  async typing("));
  const cleanUpAt = peek.indexOf("const cleanUp = ");
  const openAt = peek.indexOf('this.capture(side, "peek-open"');
  const dismissAt = peek.indexOf('this.capture(side, "peek-dismiss"');
  assert.ok(cleanUpAt > 0 && cleanUpAt < openAt && openAt < dismissAt);
  assert.equal(peek.match(/await orClose\(async \(\) => \{\n\s*const (?:cap|dismissCap) = await this\.capture\(side, "peek-(?:open|dismiss)"/g)?.length, 2);
});
