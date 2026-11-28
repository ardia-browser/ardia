import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deadline = join(dirname(fileURLToPath(import.meta.url)), "deadline");
const scratch = mkdtempSync(join(tmpdir(), "deadline-test-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const alive = (pid) => spawnSync("kill", ["-0", String(pid)]).status === 0;
const settle = (ms) => spawnSync("sleep", [String(ms / 1000)]);

const helperScript = (pidFile) => `sleep 30 & echo $! > ${pidFile}; ${"$"}{EXIT_AFTER:-sleep 30}`;

test("at the deadline the command and the helpers it left behind are stopped, with exit 124", () => {
  const pidFile = join(scratch, "deadline.pid");
  const started = Date.now();
  const run = spawnSync(deadline, ["--timeout", "1", "--", "bash", "-c", helperScript(pidFile)], { encoding: "utf8" });
  assert.equal(run.status, 124);
  assert.match(run.stderr, /stopped bash and everything it started at the 1 s deadline/);
  assert.ok(Date.now() - started < 8000);
  settle(300);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
});

test("a command that exits on its own keeps its status and its helpers are stopped too", () => {
  const pidFile = join(scratch, "exit.pid");
  const run = spawnSync(deadline, ["--", "bash", "-c", helperScript(pidFile)], { encoding: "utf8", env: { ...process.env, EXIT_AFTER: "exit 3" } });
  assert.equal(run.status, 3);
  settle(300);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
});

test("a passing command exits 0 at once instead of waiting for its deadline", () => {
  const started = Date.now();
  assert.equal(spawnSync(deadline, ["--timeout", "60", "--", "true"]).status, 0);
  assert.ok(Date.now() - started < 3000);
});

test("bad arguments are refused with 64 and --help prints the header", () => {
  assert.equal(spawnSync(deadline, ["--timeout", "x", "--", "true"]).status, 64);
  assert.equal(spawnSync(deadline, ["--"]).status, 64);
  const help = spawnSync(deadline, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /swiftpm-testing-helper/);
});
