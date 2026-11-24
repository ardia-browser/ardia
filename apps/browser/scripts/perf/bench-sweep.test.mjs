import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { environmentOf, findMarked, insideAny, markedBy, markerProblem, parentOf, stopMarked } from "./bench-sweep.mjs";

const exited = (pid) => {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().startsWith("Z");
    } catch {
      return true;
    }
  }
  return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z");
};

const alive = (pid) => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !exited(pid);
};

const APP = `const { writeFileSync, appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [pidfile, log, mode] = process.argv.slice(1);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { appendFileSync(log, sig + "\\n"); if (mode === "plain") process.exit(0); });
if (mode === "parent") spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidfile, String(process.pid));
setInterval(() => {}, 1000);`;

function launchLikeOpen(dir, name, env, mode = "plain") {
  const pidfile = join(dir, `${name}.pid`), log = join(dir, `${name}.signals`);
  spawnSync(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], ...process.argv.slice(2)], { detached: true, stdio: "ignore" }).unref()`, APP, pidfile, log, mode], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore" });
  for (let i = 0; i < 300 && !(existsSync(pidfile) && readFileSync(pidfile, "utf8")); i++) spawnSync("sleep", ["0.02"]);
  return { pid: +readFileSync(pidfile, "utf8"), signals: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

const withDir = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-sweep-"));
  const started = [];
  try {
    await fn(dir, started);
  } finally {
    for (const pid of started) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a process is the gate's only when ARDIA_DATA_DIR or HOME names a path inside a marker folder", () => {
  assert.equal(insideAny("/tmp/ac-gate.1/d", ["/tmp/ac-gate.1"]), true);
  assert.equal(insideAny("/tmp/ac-gate.1", ["/tmp/ac-gate.1"]), true);
  assert.equal(insideAny("/tmp/ac-gate.10/d", ["/tmp/ac-gate.1"]), false);
  assert.equal(markedBy({ ARDIA_DATA_DIR: "/o/prep/0.2.48/data/launch-1" }, ["/o/prep"]), true);
  assert.equal(markedBy({ HOME: "/tmp/ac-gate.1/carryover/home" }, ["/tmp/ac-gate.1"]), true);
  assert.equal(markedBy({ HOME: homedir() }, ["/tmp/ac-gate.1"]), false);
  assert.equal(markedBy({ TMPDIR: "/tmp/ac-gate.1" }, ["/tmp/ac-gate.1"]), false);
  assert.equal(markedBy({}, ["/tmp/ac-gate.1"]), false);
});

test("a marker folder that could hold someone else's instances is refused", () => {
  for (const dir of ["/", "/tmp", "/private/tmp", "/Users", homedir(), tmpdir()]) assert.ok(markerProblem(dir), dir);
  assert.equal(markerProblem(join(homedir(), "ardia-scratch", "gate-0.2.49", "prep")), null);
  assert.equal(markerProblem("/tmp/ac-gate.ABCDEF"), null);
});

test("stop signals only marked processes: the owner's Ardia (same executable, its own data dir) never gets a signal", withDir(async (dir, started) => {
  const marked = join(dir, "gate");
  mkdirSync(marked);
  const owner = launchLikeOpen(dir, "owner", { ARDIA_DATA_DIR: join(dir, "owner-data"), HOME: homedir() });
  const plain = launchLikeOpen(dir, "plain", { ARDIA_DATA_DIR: join(marked, "launch-1") });
  const stubborn = launchLikeOpen(dir, "stubborn", { HOME: join(marked, "carryover", "home") }, "parent");
  started.push(owner.pid, plain.pid, stubborn.pid);
  assert.equal(environmentOf(plain.pid)?.ARDIA_DATA_DIR, join(marked, "launch-1"));
  const found = findMarked([marked]);
  assert.ok(found.includes(plain.pid) && found.includes(stubborn.pid));
  assert.ok(!found.includes(owner.pid));
  const kid = found.find((p) => p !== plain.pid && p !== stubborn.pid);
  assert.ok(kid, "the stubborn app's child inherits its environment and is found too");
  assert.notEqual(parentOf(plain.pid), process.pid);
  assert.ok(parentOf(plain.pid) > 0);
  started.push(kid);
  const r = await stopMarked([marked], { quitSecs: 1, killSecs: 3 });
  assert.deepEqual(r.left, []);
  const survivors = [plain.pid, stubborn.pid, kid].filter(alive);
  if (survivors.length && process.platform === "linux")
    for (const pid of survivors) {
      const read = (f) => { try { return readFileSync(`/proc/${pid}/${f}`, "utf8").replaceAll("\0", " ").slice(0, 200); } catch (e) { return e.code; } };
      console.log(`survivor ${pid} stat=${read("stat")} cmdline=${read("cmdline")} environ.length=${read("environ").length}`);
    }
  assert.deepEqual(survivors, []);
  assert.ok(alive(owner.pid));
  assert.deepEqual(owner.signals(), []);
}));

test("a data dir spelled through a symlink still matches its marker, and a sibling of the marker never does", withDir(async (dir) => {
  const { symlinkSync } = await import("node:fs");
  const { canonical } = await import("./bench-sweep.mjs");
  mkdirSync(join(dir, "real", "gate", "prep"), { recursive: true });
  symlinkSync(join(dir, "real"), join(dir, "alias"));
  const marker = join(dir, "real", "gate", "prep");
  assert.equal(canonical(join(dir, "alias", "gate", "prep", "rc", "data", "not-yet")), join(canonical(join(dir, "real")), "gate", "prep", "rc", "data", "not-yet"));
  assert.equal(markedBy({ ARDIA_DATA_DIR: join(dir, "alias", "gate", "prep", "rc", "data") }, [canonical(marker)]), true);
  assert.equal(markedBy({ ARDIA_DATA_DIR: join(dir, "alias", "gate", "other-agent", "data") }, [canonical(marker)]), false);
  assert.equal(markedBy({ ARDIA_DATA_DIR: join(dir, "alias", "gate") }, [canonical(marker)]), false);
  assert.equal(markedBy({ ARDIA_DATA_DIR: "relative/path" }, [canonical(marker)]), false);
}));
