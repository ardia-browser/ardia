import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { descendants, insideApp, launchedTree, processTable, stopTree, survivors } from "./processes.mjs";

const APP = "/x/Bench.app";
const table = [
  { pid: 10, ppid: 1, command: `${APP}/Contents/MacOS/Ardia --mute-audio` },
  { pid: 11, ppid: 10, command: `${APP}/Contents/Frameworks/Helper --type=renderer` },
  { pid: 12, ppid: 11, command: `${APP}/Contents/Frameworks/Helper --type=utility` },
  { pid: 20, ppid: 1, command: `/usr/bin/timeout 1500 node native-bench.mjs --app ${APP}` },
  { pid: 21, ppid: 20, command: `node native-bench.mjs --app ${APP} --label main` },
  { pid: 30, ppid: 1, command: `${APP}/Contents/MacOS/Ardia --another-bench` },
];

test("the launched tree is the launched pid and its descendants inside the app, never a command that only names it", () => {
  assert.deepEqual(descendants(10, table).map((p) => p.pid), [11, 12]);
  assert.deepEqual(launchedTree(10, APP, table).map((p) => p.pid), [10, 11, 12]);
  assert.equal(insideApp(table[4].command, APP), false);
  assert.equal(insideApp(`${APP}x/Contents/MacOS/Ardia`, APP), false);
});

test("survivors are only tree members still running the same command, so a reused pid is left alone", () => {
  const tree = launchedTree(10, APP, table);
  const later = [{ pid: 11, ppid: 1, command: table[1].command }, { pid: 12, ppid: 1, command: "/bin/zsh" }, ...table.slice(3)];
  assert.deepEqual(survivors(tree, APP, later), [11]);
});

test("stopping a launched tree kills its helpers and spares a process whose arguments merely contain the app path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-procs-"));
  const app = join(dir, "Bench.app");
  const exe = join(app, "Contents", "MacOS", "Bench");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  copyFileSync("/bin/sleep", exe);
  const helper = spawn(exe, ["30"], { stdio: "ignore" });
  const decoy = spawn("/bin/sh", ["-c", "sleep 30", exe], { stdio: "ignore" });
  try {
    await new Promise((ok) => setTimeout(ok, 300));
    const tree = processTable().filter((p) => p.pid === helper.pid);
    assert.equal(tree.length, 1);
    const helperGone = new Promise((ok) => helper.once("exit", (code, signal) => ok(signal)));
    assert.deepEqual(await stopTree(tree, app, { graceMs: 200 }), [helper.pid]);
    assert.equal(await helperGone, "SIGKILL");
    assert.equal(decoy.exitCode, null);
    assert.equal(decoy.signalCode, null);
  } finally {
    helper.kill("SIGKILL");
    decoy.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
