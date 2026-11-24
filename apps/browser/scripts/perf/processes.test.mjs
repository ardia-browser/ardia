import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { descendants, insideApp, launchedTree, parseTable, processTable, quitTargets, signalIfSame, stopTree, survivors } from "./processes.mjs";

const APP = "/x/Bench.app";
const T = 1_700_000_000_000;
const table = [
  { pid: 10, ppid: 1, started: T, command: `${APP}/Contents/MacOS/Ardia --mute-audio` },
  { pid: 11, ppid: 10, started: T + 1000, command: `${APP}/Contents/Frameworks/Helper --type=renderer` },
  { pid: 12, ppid: 11, started: T + 1000, command: `${APP}/Contents/Frameworks/Helper --type=utility` },
  { pid: 20, ppid: 1, started: T - 9000, command: `/usr/bin/timeout 1500 node native-bench.mjs --app ${APP}` },
  { pid: 21, ppid: 20, started: T - 9000, command: `node native-bench.mjs --app ${APP} --label main` },
  { pid: 30, ppid: 1, started: T - 60_000, command: `${APP}/Contents/MacOS/Ardia --another-bench` },
];

test("ps rows parse with their start time, so a process is known by pid, start and command", () => {
  const rows = parseTable(["  411     1 Thu Nov 20 05:16:37 2026     /x/Bench.app/Contents/MacOS/Ardia --mute-audio",
    "  412   411 Thu Nov  5 05:16:38 2026     /x/Bench.app/Contents/Frameworks/Helper --type=gpu-process"].join("\n"));
  assert.deepEqual(rows.map((r) => [r.pid, r.ppid, r.command.split(" ")[1]]), [[411, 1, "--mute-audio"], [412, 411, "--type=gpu-process"]]);
  assert.equal(rows[0].started, new Date(2026, 10, 20, 5, 16, 37).getTime());
  assert.equal(rows[1].started, new Date(2026, 10, 5, 5, 16, 38).getTime());
  assert.ok(processTable().some((p) => p.pid === process.pid && p.started > 0));
});

test("the launched tree is the launched pid and its descendants inside the app, never a command that only names it", () => {
  assert.deepEqual(descendants(10, table).map((p) => p.pid), [11, 12]);
  assert.deepEqual(launchedTree(10, APP, table).map((p) => p.pid), [10, 11, 12]);
  assert.equal(insideApp(table[4].command, APP), false);
  assert.equal(insideApp(`${APP}x/Contents/MacOS/Ardia`, APP), false);
});

test("survivors are tree members with the same start and command, so a reused pid is left alone even with identical arguments", () => {
  const tree = launchedTree(10, APP, table);
  const later = [
    { ...table[1], ppid: 1 },
    { pid: 12, ppid: 1, started: T + 5000, command: table[2].command },
    { pid: 10, ppid: 1, started: T + 7000, command: table[0].command },
    ...table.slice(3),
  ];
  assert.deepEqual(survivors(tree, APP, later).map((p) => p.pid), [11]);
  assert.equal(signalIfSame(table[0], 0, later), false);
});

test("quit signals only the confirmed browser's recorded tree, never an untracked process of the same app copy", () => {
  const tracked = launchedTree(10, APP, table);
  const afterCrash = [
    { ...table[1], ppid: 1 },
    { pid: 12, ppid: 1, started: T + 5000, command: table[2].command },
    { pid: 77, ppid: 1, started: T, command: `${APP}/Contents/Frameworks/Helper --type=renderer` },
    ...table.slice(3),
  ];
  assert.deepEqual(quitTargets({ tracked, confirmed: true }, APP, afterCrash).map((p) => p.pid), [11]);
  assert.deepEqual(quitTargets({ tracked, confirmed: false }, APP, afterCrash), []);
  assert.deepEqual(quitTargets({ tracked: [], confirmed: true }, APP, afterCrash), []);
});

async function until(check, what, deadlineMs = 10_000) {
  for (const end = Date.now() + deadlineMs; Date.now() < end; await new Promise((ok) => setTimeout(ok, 20))) {
    const value = check();
    if (value) return value;
  }
  throw new Error(`${what} didn't happen within ${deadlineMs} ms`);
}

test("stopping a launched tree kills its helpers and spares a process whose arguments merely contain the app path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-procs-"));
  const app = join(dir, "Bench.app");
  const exe = join(app, "Contents", "MacOS", "Bench");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  symlinkSync(process.execPath, exe);
  const { NODE_OPTIONS, ...env } = process.env;
  const idle = "setTimeout(() => {}, 30000)";
  const helper = spawn(exe, ["-e", idle], { stdio: "ignore", env });
  const decoy = spawn(process.execPath, ["-e", idle, exe], { stdio: "ignore", env });
  const helperGone = new Promise((ok) => helper.once("exit", (code, signal) => ok(signal)));
  try {
    const tree = await until(() => {
      const found = processTable().filter((p) => p.pid === helper.pid && p.command.startsWith(exe));
      return found.length ? found : null;
    }, "the helper's exec");
    const decoyCommand = await until(() => processTable().find((p) => p.pid === decoy.pid && p.command.includes(exe))?.command, "the decoy's exec");
    assert.equal(insideApp(decoyCommand, app), false);
    assert.deepEqual(await stopTree(tree, app, { graceMs: 200 }), [helper.pid]);
    assert.equal(await Promise.race([helperGone, new Promise((ok) => setTimeout(() => ok("still running"), 10_000))]), "SIGKILL");
    assert.equal(decoy.exitCode, null);
    assert.equal(decoy.signalCode, null);
  } finally {
    helper.kill("SIGKILL");
    decoy.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
