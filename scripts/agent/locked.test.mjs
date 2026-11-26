import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const locked = join(dirname(fileURLToPath(import.meta.url)), "locked");
const canLock = process.platform !== "win32" && spawnSync("bash", ["-c", "command -v lockf || command -v flock"]).status === 0;
const PROFILE = [
  "(version 1)",
  "(deny default)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow file-read*)",
  '(allow file-write-data (literal "/dev/null"))',
  "(allow sysctl-read)",
  "(allow mach-lookup)",
  "(allow signal (target same-sandbox))",
].join("");
const canSandbox = canLock && process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && spawnSync("/usr/bin/sandbox-exec", ["-p", PROFILE, "/usr/bin/true"]).status === 0;

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function lockRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locked-test-"));
  const before = [];
  t.after(async () => {
    for (const step of before.reverse()) await step();
    rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, AC_LOCK_ROOT: root };
  for (const name of ["AC_LOCKED_HELD", "AC_LOCKED_INNER", "AC_LOCKED_AS", "AC_LOCKED_DEADLINE"]) delete env[name];
  return { root, env, kernel: join(root, "ac-pod.lockf"), cleanup: (step) => before.push(step) };
}

function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {}
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function openGate(gate) {
  const fd = openSync(gate, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    writeSync(fd, "\n");
  } finally {
    closeSync(fd);
  }
}

async function holdLock({ root, env, cleanup }) {
  const ready = join(root, "ready");
  const gate = join(root, "gate");
  assert.equal(spawnSync("mkfifo", [gate]).status, 0);
  const holder = spawn(locked, ["pod", "--wait", "10", "--", "bash", "-c", `touch "${ready}"; read -r _ < "${gate}"`], { env, stdio: "ignore", detached: true });
  const exited = new Promise((resolve) => holder.once("exit", (code, signal) => resolve(code ?? signal)));
  let released;
  const release = () =>
    (released ??= (async () => {
      if (holder.exitCode === null && holder.signalCode === null) {
        try {
          openGate(gate);
        } catch {
          signalGroup(holder.pid, "SIGTERM");
        }
      }
      const fallback = setTimeout(() => signalGroup(holder.pid, "SIGKILL"), 10_000);
      try {
        return await exited;
      } finally {
        clearTimeout(fallback);
        const groupGone = () => !groupAlive(holder.pid);
        await until(groupGone, 5_000, "the holder's process group to exit").catch(async () => {
          signalGroup(holder.pid, "SIGKILL");
          await until(groupGone, 5_000, "the holder's process group to exit after SIGKILL");
        });
      }
    })());
  cleanup(release);
  await until(() => existsSync(ready), 10_000, "the holder to take the pod lock");
  return release;
}

test("AC_LOCKED_HELD naming a live process that doesn't hold the lock doesn't skip it", { skip: !canLock && "needs lockf or flock" }, async (t) => {
  const lock = lockRoot(t);
  const { root, env, kernel } = lock;
  const release = await holdLock(lock);
  const record = lstatSync(join(root, "ac-pod.held"));
  assert.equal(record.isFile(), true);
  assert.equal(record.mode & 0o777, 0o600);
  assert.equal(record.uid, process.getuid());
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => bystander.kill("SIGKILL"));
  for (const held of [`${bystander.pid} ${kernel}`, `${bystander.pid} ${"0".repeat(32)} ${kernel}`]) {
    const spoofed = spawnSync(locked, ["pod", "--wait", "1", "--", "echo", "RAN"], { env: { ...env, AC_LOCKED_HELD: held }, encoding: "utf8", timeout: 20_000 });
    assert.equal(spoofed.stdout.includes("RAN"), false, spoofed.stderr);
    assert.equal(spoofed.status, 75, spoofed.stderr);
  }
  assert.equal(await release(), 0);
  assert.equal(existsSync(join(root, "ac-pod.held")), false, "the holder clears its record when it finishes");
});

test("a nested call runs inside the enclosing call's lock", { skip: !canLock && "needs lockf or flock" }, (t) => {
  const { env } = lockRoot(t);
  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", locked, "pod", "--wait", "1", "--", "echo", "NESTED"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /NESTED/);
  assert.match(nested.stderr, /already held by an enclosing call/);
});

test("a nested call inside a macOS sandbox, where setuid ps can't run, still runs inside the enclosing lock", { skip: !canSandbox && "needs macOS sandbox-exec outside a sandbox" }, (t) => {
  const { env } = lockRoot(t);
  assert.notEqual(spawnSync("/usr/bin/sandbox-exec", ["-p", PROFILE, "/bin/ps", "-o", "ppid=", "-p", String(process.pid)]).status, 0, "the profile lets ps run, so this test proves nothing");
  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", "/usr/bin/sandbox-exec", "-p", PROFILE, locked, "pod", "--wait", "2", "--", "echo", "NESTED"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /NESTED/);
  assert.match(nested.stderr, /already held by an enclosing call/);
});

test("a nested call doesn't trust a lock record that is a symlink", { skip: !canLock && "needs lockf or flock" }, (t) => {
  const { env } = lockRoot(t);
  const swap = `h="$AC_LOCK_ROOT/ac-pod.held"; cp "$h" "$h.copy"; ln -sf "$h.copy" "$h"; "${locked}" pod --wait 1 -- echo NESTED; echo "nested=$?"`;
  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", "bash", "-c", swap], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.doesNotMatch(nested.stdout, /NESTED/);
  assert.match(nested.stdout, /nested=75/);
});

test("a lock record path taken by a directory is left alone, and the nested call takes the lock itself", { skip: !canLock && "needs lockf or flock" }, (t) => {
  const { root, env } = lockRoot(t);
  mkdirSync(join(root, "ac-pod.held"));
  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", "bash", "-c", `"${locked}" pod --wait 1 -- echo NESTED; echo "nested=$?"`], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.doesNotMatch(nested.stdout, /NESTED/);
  assert.match(nested.stdout, /nested=75/);
  assert.deepEqual(readdirSync(join(root, "ac-pod.held")), []);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("ac-pod.held.")), []);
});
