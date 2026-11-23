import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allFinished, collectWithRetry, evaluate, JOURNEYS, laneLabel, portPlan, positiveInteger, replayArgs, retryPlan, shellQuote, SMALL_JOURNEYS, spawnAsync, splitRuns, withRetry } from "./ratchet.mjs";

const over = (key, tier = "exact") => ({ tier, key, ceiling: 1, value: 2, kind: "over" });

test("a run with nothing over retries nothing", () => {
  assert.deepEqual(retryPlan([{ tier: "exact", key: "hover.commits", ceiling: 25, value: 25, kind: "same" }]), { big: null, small: null });
});

test("the retry reruns the journeys in order up to the last one that went over, so each keeps the scenarios before it", () => {
  const plan = retryPlan([over("hover.renders.TabRow"), over("switchTabs.commits")]);
  assert.deepEqual(plan, { big: ["startup", "launch", "idle", "typing", "switchTabs", "scroll", "hover"], small: null });
});

test("a launch count over reruns only the launch", () => {
  assert.deepEqual(retryPlan([over("launch.renders", "noisy")]).big, ["startup", "launch"]);
});

test("open and close counts retry up to the openClose scenario, leaving out the churn after it", () => {
  assert.deepEqual(retryPlan([over("close.renders")]).big, JOURNEYS.slice(0, -1));
  assert.deepEqual(retryPlan([over("open.mounts.TabRow")]).big, JOURNEYS.slice(0, -1));
});

test("the one-tab launch reruns only when one of its own counts went over", () => {
  assert.deepEqual(retryPlan([over("small.launch.renders")]), { big: null, small: SMALL_JOURNEYS });
  assert.deepEqual(retryPlan([over("launch.renders"), over("small.launch.commits")]), { big: ["startup", "launch"], small: SMALL_JOURNEYS });
});

test("micro and instruction counts never trigger an app rerun: Node counts don't wobble", () => {
  assert.deepEqual(retryPlan([over("micro.sidebar500", "micro"), over("micro.instrPerRound", "instr")]), { big: null, small: null });
});

test("every journey a count can belong to is one the retry knows how to run", () => {
  for (const s of JOURNEYS.filter((j) => j !== "startup" && j !== "nodeChurn")) assert.deepEqual(retryPlan([over(`${s}.commits`)]).big, JOURNEYS.slice(0, JOURNEYS.indexOf(s) + 1));
});

test("nodes left behind are never rerun: the worst run decides them, so a second run can only cost time", () => {
  assert.deepEqual(retryPlan([over("nodeChurn.nativeNodesLeft")]), { big: null, small: null });
  assert.deepEqual(retryPlan([over("nodeChurn.nativeNodesLeft"), over("hover.commits")]).big, JOURNEYS.slice(0, JOURNEYS.indexOf("hover") + 1));
});

test("baseline splits the journeys' runs evenly over the lanes and keeps every run", () => {
  assert.deepEqual(splitRuns(8, 4), [2, 2, 2, 2]);
  assert.deepEqual(splitRuns(10, 4), [3, 3, 2, 2]);
  assert.deepEqual(splitRuns(8, 1), [8]);
  assert.deepEqual(splitRuns(2, 4), [1, 1]);
});

test("the one-tab session never shares a label, app copy or report with the big one, whatever the label", () => {
  for (const name of ["ratchet", "stable", "s", "x-again"]) assert.notEqual(laneLabel(name, "small"), laneLabel(name, "big"));
});

test("lanes never share a test-server port or a remote-debugging port, however many runs a lane has", () => {
  for (const counts of [[1, 1], [2, 2, 2, 2], [21, 21, 20, 20], [40]]) {
    const plan = portPlan({ port: 47831, cdpPort: 9700, counts });
    const used = new Set();
    plan.forEach(({ port, cdpPort }, lane) => {
      for (const p of [port, ...Array.from({ length: counts[lane] }, (_, r) => cdpPort + r)]) {
        assert.ok(!used.has(p), `port ${p} used twice with ${counts}`);
        used.add(p);
      }
    });
  }
});

test("remote-debugging ports are reserved for the runs each lane has, and the one-at-a-time one-tab phase reuses them", () => {
  const plan = portPlan({ port: 47831, cdpPort: 9700, counts: [2, 2, 2, 2], serialRuns: 8 });
  assert.deepEqual(plan.map((p) => p.cdpPort), [9700, 9702, 9704, 9706]);
  assert.deepEqual(plan.serial, { port: 47831, cdpPort: 9700, capacity: 8 });
  assert.doesNotThrow(() => portPlan({ port: 47831, cdpPort: 65528, counts: [2, 2, 2, 2], serialRuns: 8 }));
});

test("ports outside 1024..65535 or a test server inside the remote-debugging range fail before anything launches", () => {
  assert.doesNotThrow(() => portPlan({ port: 64000, cdpPort: 9700, counts: [2, 2, 2, 2] }));
  assert.throws(() => portPlan({ port: 65534, cdpPort: 9700, counts: [1, 1, 1, 1] }), /outside 1024..65535/);
  assert.throws(() => portPlan({ port: 47831, cdpPort: 65530, counts: [8, 8, 8, 8] }), /outside 1024..65535/);
  assert.throws(() => portPlan({ port: 47831, cdpPort: 65530, counts: [1], serialRuns: 8 }), /outside 1024..65535/);
  assert.throws(() => portPlan({ port: 9705, cdpPort: 9700, counts: [8, 8] }), /falls in the remote-debugging ports/);
});

test("--runs and --lanes take positive whole numbers only", () => {
  assert.equal(positiveInteger("8", "--runs"), 8);
  assert.equal(positiveInteger(4, "--lanes"), 4);
  for (const bad of ["2.5", "0", "-1", "abc", "1e3", "9007199254740993"]) assert.throws(() => positiveInteger(bad, "--lanes"), /--lanes must be a positive whole number/);
});

test("baseline refuses a fractional --lanes before it runs anything", () => {
  const r = spawnSync(process.execPath, [new URL("./ratchet.mjs", import.meta.url).pathname, "baseline", "--runs", "8", "--lanes", "2.5", "--app", "/nonexistent/Ardia.app", "--bundle", "/nonexistent.jsbundle", "--out", mkdtempSync(join(tmpdir(), "ratchet-lanes-"))], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--lanes must be a positive whole number, got 2.5/);
});

const report = (dir, name, seed, results) => {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ label: name, seed, benchRevision: 5, results: results.map((r) => ({ probeRevision: 2, ...r })) }));
  return file;
};
const stats = (commits, renders = {}) => ({ stats: { commits, hostUpdates: 0, renders } });
const ceilings = { revisions: { probe: 2, bench: 5 }, exact: { "hover.commits": 25, "idle.commits": 0, "small.launch.commits": 10 }, noisy: {}, micro: {}, instr: {} };

test("a count over in the first run and back under in the retry passes, as with a full rerun", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const first = report(dir, "ratchet", "big", [{ hover: stats(26), idle: stats(0) }]);
  const small = report(dir, "satchet", "small", [{ launch: stats(10) }]);
  const again = report(dir, "ratchet-again", "big", [{ hover: stats(25) }]);
  assert.equal(evaluate(ceilings, { files: [first, small] }).rows.filter((r) => r.kind === "over").length, 1);
  const result = evaluate(ceilings, { files: [first, small], retryFiles: [again] });
  assert.deepEqual(result.rows.filter((r) => r.kind === "over"), []);
  assert.ok(result.ran.has("idle") && result.ran.has("hover") && result.ran.has("small.launch"));
});

test("a count over in both runs fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const first = report(dir, "ratchet", "big", [{ hover: stats(27), idle: stats(0) }]);
  const again = report(dir, "ratchet-again", "big", [{ hover: stats(26) }]);
  const result = evaluate(ceilings, { files: [first], retryFiles: [again] });
  assert.deepEqual(result.rows.filter((r) => r.kind === "over").map((r) => [r.key, r.value]), [["hover.commits", 26]]);
});

test("scenarios the retry didn't run keep their first-run verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const first = report(dir, "ratchet", "big", [{ hover: stats(26), idle: stats(1) }]);
  const again = report(dir, "ratchet-again", "big", [{ hover: stats(25) }]);
  const result = evaluate(ceilings, { files: [first], retryFiles: [again] });
  assert.deepEqual(result.rows.filter((r) => r.kind === "over").map((r) => r.key), ["idle.commits"]);
});

test("a named count seen only in one of the two runs counts as zero in the other", () => {
  const first = { values: { "hover.renders.Row": [3] }, runsBySeed: { big: 1, small: 0 }, ran: new Set(["hover"]) };
  const retry = { values: { "hover.renders.Other": [2] }, runsBySeed: { big: 1, small: 0 }, ran: new Set(["hover"]) };
  assert.deepEqual(withRetry(first, retry).values, { "hover.renders.Row": [3, 0], "hover.renders.Other": [0, 2] });
});

test("nodes left behind fail on either run, so a retry can't wash out a leak", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const leak = { ...ceilings, exact: { "nodeChurn.nativeNodesLeft": 0 } };
  const first = report(dir, "ratchet", "big", [{ nodeChurn: { left: 3 } }]);
  const again = report(dir, "ratchet-again", "big", [{ nodeChurn: { left: 0 } }]);
  assert.deepEqual(evaluate(leak, { files: [first], retryFiles: [again] }).rows.filter((r) => r.kind === "over").map((r) => r.key), ["nodeChurn.nativeNodesLeft"]);
});

test("lanes run at the same time", async () => {
  const started = Date.now();
  const nap = `setTimeout(() => {}, 600)`;
  await allFinished([spawnAsync(process.execPath, ["-e", nap]), spawnAsync(process.execPath, ["-e", nap]), spawnAsync(process.execPath, ["-e", nap])]);
  assert.ok(Date.now() - started < 1500, `three 600 ms lanes took ${Date.now() - started} ms`);
});

test("a failing lane fails the run only after the others have finished, so no instance is left running", async () => {
  const done = [];
  const slow = spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 400)"]).then(() => done.push("slow"));
  const fail = spawnAsync(process.execPath, ["-e", "process.exit(3)"]);
  await assert.rejects(allFinished([slow, fail]), /exited with 3/);
  assert.deepEqual(done, ["slow"]);
});

test("a lane's stdout is captured when asked", async () => {
  assert.equal(await spawnAsync(process.execPath, ["-e", "console.log('COUNTS {}')"], { capture: true }), "COUNTS {}\n");
});

const realCeilings = JSON.parse(readFileSync(new URL("./ratchet.json", import.meta.url), "utf8"));
const checkCli = (...args) => spawnSync(process.execPath, [new URL("./ratchet.mjs", import.meta.url).pathname, "check", ...args], { encoding: "utf8" });

test("check --retry reproduces run's verdict from the saved reports, and keeps judging the scenarios the retry didn't rerun", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-check-retry-"));
  const hover = realCeilings.exact["hover.commits"];
  const idle = realCeilings.exact["idle.commits"];
  const rev = { benchRevision: Number(realCeilings.revisions.bench) };
  const write = (name, results) => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ label: name, seed: "big", ...rev, results: results.map((r) => ({ probeRevision: Number(realCeilings.revisions.probe), ...r })) }));
    return file;
  };
  const first = write("first", [{ hover: stats(hover + 1), idle: stats(idle) }]);
  const again = write("again", [{ hover: stats(hover) }]);
  assert.equal(checkCli(first).status, 1);
  assert.equal(checkCli(first, "--retry", again).status, 0);
  const idleOver = write("idle-over", [{ hover: stats(hover + 1), idle: stats(idle + 1) }]);
  const result = checkCli(idleOver, "--retry", again);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /idle\.commits/);
});

test("lower --retry sees the retry's runs, as run judged them", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-lower-retry-"));
  const first = report(dir, "first", "big", [{ hover: stats(20), idle: stats(0) }]);
  const again = report(dir, "again", "big", [{ hover: stats(24) }]);
  const { values, ran } = collectWithRetry([first], [again]);
  assert.deepEqual(values["hover.commits"], [20, 24]);
  assert.deepEqual(values["idle.commits"], [0]);
  assert.ok(ran.has("idle"));
});

const ratchetUrl = new URL("./ratchet.mjs", import.meta.url).href;
const STUBBORN = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid) => {
  for (let i = 0; i < 60 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
};
const waitForFile = async (file) => {
  for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  return Number(readFileSync(file, "utf8"));
};

function ratchetHarness(lanes, { deadlineMs = 20_000 } = {}) {
  const spawns = lanes.map(({ script, lane }) => `spawnAsync(process.execPath, ["-e", ${JSON.stringify(script)}], { lane: ${lane} }).catch(() => {});`).join("\n");
  const ratchet = spawn(process.execPath, ["--input-type=module", "-e", `
    import { stopOnSignals, spawnAsync } from ${JSON.stringify(ratchetUrl)};
    stopOnSignals({ deadlineMs: ${deadlineMs} });
    ${spawns}
    setInterval(() => {}, 1000);`], { stdio: "ignore" });
  const exited = new Promise((resolve) => ratchet.once("exit", (code, signal) => resolve(code ?? signal)));
  return { ratchet, exited };
}

test("a signal is forwarded to each lane, which finishes its own cleanup before the ratchet exits with the first signal's code, and the bundler is killed outright", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-forward-"));
  const ready = join(dir, "ready");
  const cleaned = join(dir, "cleaned");
  const forwarded = join(dir, "forwarded");
  const grandchildFile = join(dir, "grandchild");
  const lane = `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on("SIGINT", () => (require("fs").writeFileSync(${JSON.stringify(forwarded)}, "1"), setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(cleaned)}, "1"); process.exit(130); }, 300))); setInterval(() => {}, 1000);`;
  const grandchild = `require("fs").writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); ${STUBBORN}`;
  const bundler = `require("child_process").execFileSync(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`;
  const { ratchet, exited } = ratchetHarness([{ script: lane, lane: true }, { script: bundler, lane: false }]);
  const lanePid = await waitForFile(ready);
  const grandchildPid = await waitForFile(grandchildFile);
  ratchet.kill("SIGINT");
  await waitForFile(forwarded);
  ratchet.kill("SIGTERM");
  assert.equal(await exited, 130);
  assert.ok(existsSync(cleaned), "the ratchet exited before the lane finished its cleanup");
  assert.ok(await gone(lanePid));
  assert.ok(await gone(grandchildPid), "the bundler's child survived");
});

test("once a signal starts the shutdown, a lane exiting with the signal's code can't replace the ratchet's exit code", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-sole-exit-"));
  const ready = join(dir, "ready");
  const lane = `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 1000);`;
  const ratchet = spawn(process.execPath, ["--input-type=module", "-e", `
    import { stopOnSignals, spawnAsync, finish } from ${JSON.stringify(ratchetUrl)};
    stopOnSignals({ deadlineMs: 2000 });
    try { await spawnAsync(process.execPath, ["-e", ${JSON.stringify(lane)}], { lane: true }); finish(0); }
    catch { finish(2); }
    setInterval(() => {}, 1000);`], { stdio: "ignore" });
  const exited = new Promise((resolve) => ratchet.once("exit", (code, signal) => resolve(code ?? signal)));
  await waitForFile(ready);
  ratchet.kill("SIGTERM");
  assert.equal(await exited, 143);
});

test("a lane that doesn't exit by the deadline is killed with its whole process group", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-deadline-"));
  const ready = join(dir, "ready");
  const childFile = join(dir, "child");
  const inner = `require("fs").writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); ${STUBBORN}`;
  const lane = `process.on("SIGTERM", () => {}); require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const { ratchet, exited } = ratchetHarness([{ script: lane, lane: true }], { deadlineMs: 500 });
  const lanePid = await waitForFile(ready);
  const childPid = await waitForFile(childFile);
  const signalled = Date.now();
  ratchet.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.ok(Date.now() - signalled < 5000);
  assert.ok(await gone(lanePid), "the stuck lane survived");
  assert.ok(await gone(childPid), "the stuck lane's child survived");
});

test("a SIGTERM while the instruction counter runs stops it at once and exits 143 instead of finishing and passing", { timeout: 60_000, skip: process.platform !== "darwin" && "the instruction counter reads macOS time -l" }, async () => {
  const ratchet = spawn(process.execPath, ["--input-type=module", "-e", `
    import { stopOnSignals, instrPerRound } from ${JSON.stringify(ratchetUrl)};
    stopOnSignals();
    console.log("started");
    await instrPerRound();
    console.log("finished");
    process.exit(0);`], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  ratchet.stdout.setEncoding("utf8").on("data", (d) => (out += d));
  const exited = new Promise((resolve) => ratchet.once("exit", (code, signal) => resolve(code ?? signal)));
  for (let i = 0; i < 100 && !out.includes("started"); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  const signalled = Date.now();
  ratchet.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.ok(!out.includes("finished"));
  assert.ok(Date.now() - signalled < 3000, `took ${Date.now() - signalled} ms to stop`);
});

test("shellQuote keeps paths with spaces and quotes whole through a shell", () => {
  const path = "/tmp/a b/it's here.json";
  const echoed = spawnSync("/bin/sh", ["-c", `printf %s ${shellQuote(path)}`], { encoding: "utf8" }).stdout;
  assert.equal(echoed, path);
  assert.equal(shellQuote("/tmp/plain.json"), "/tmp/plain.json");
});

test("the replay command run prints gives run's own verdict, Node and instruction counts included", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet replay '"));
  const hover = realCeilings.exact["hover.commits"];
  const idle = realCeilings.exact["idle.commits"];
  const rev = { benchRevision: Number(realCeilings.revisions.bench) };
  const write = (name, results) => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ label: name, seed: "big", ...rev, results: results.map((r) => ({ probeRevision: Number(realCeilings.revisions.probe), ...r })) }));
    return file;
  };
  const [microKey, microCeiling] = Object.entries(realCeilings.micro)[0];
  const instrCeiling = realCeilings.instr["micro.instrPerRound"];
  const cases = [
    { micro: { [microKey]: microCeiling }, instr: null },
    { micro: { [microKey]: microCeiling + 1 }, instr: null },
    { micro: { [microKey]: microCeiling }, instr: Math.ceil(instrCeiling * 1.2) },
  ];
  const files = [write("first", [{ hover: stats(hover + 1), idle: stats(idle) }])];
  const retryFiles = [write("again", [{ hover: stats(hover) }])];
  for (const [i, { micro, instr }] of cases.entries()) {
    const microFile = join(dir, `micro ${i}.json`);
    writeFileSync(microFile, JSON.stringify(micro));
    const runVerdict = evaluate(realCeilings, { files, retryFiles, micro, instr }).rows.some((r) => r.kind === "over") ? 1 : 0;
    const command = `${shellQuote(process.execPath)} ${shellQuote(new URL("./ratchet.mjs", import.meta.url).pathname)} check ${replayArgs({ files, retryFiles, microFile, instr }).map(shellQuote).join(" ")}`;
    const replayed = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" }).status;
    assert.equal(replayed, runVerdict, `case ${i}: run says ${runVerdict}, the replay says ${replayed}`);
  }
});

test("--runs or --lanes with no value fails instead of becoming 1", () => {
  assert.throws(() => positiveInteger(true, "--runs"), /--runs needs a value/);
  const r = spawnSync(process.execPath, [new URL("./ratchet.mjs", import.meta.url).pathname, "baseline", "--runs", "--lanes", "4", "--app", "/nonexistent/Ardia.app", "--bundle", "/nonexistent.jsbundle", "--out", mkdtempSync(join(tmpdir(), "ratchet-bare-"))], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--runs needs a value/);
});
