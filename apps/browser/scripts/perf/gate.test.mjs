import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parentOf } from "./bench-sweep.mjs";

const gate = join(dirname(fileURLToPath(import.meta.url)), "gate.sh");
const APP = `const { writeFileSync, appendFileSync } = require("node:fs");
const [pidfile, log] = process.argv.slice(1);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { appendFileSync(log, sig + "\\n"); process.exit(0); });
writeFileSync(pidfile, String(process.pid));
setInterval(() => {}, 1000);`;
const LAUNCHER = `require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], ...process.argv.slice(2)], { detached: true, stdio: "ignore" }).unref()`;

const stub = (name) => `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const kind = ${JSON.stringify(name)} === "native-bench" && args.includes("prepare") ? "prep" : ${JSON.stringify(name)};
appendFileSync(process.env.STUB_LOG, JSON.stringify([kind, args]) + "\\n");
writeFileSync(process.env.STUB_LOG + "." + kind + ".pid", String(process.pid));
const env = kind.replace("-", "_");
if (process.env["STUB_IGNORE_INT_" + env]) process.on("SIGINT", () => {});
if (process.env["STUB_APP_" + env]) {
  const { spawnSync } = await import("node:child_process");
  const { existsSync, readFileSync } = await import("node:fs");
  const appPid = process.env.STUB_LOG + "." + kind + ".app";
  spawnSync(process.execPath, ["-e", ${JSON.stringify(LAUNCHER)}, ${JSON.stringify(APP)}, appPid, appPid + ".signals"], { env: { PATH: process.env.PATH, ARDIA_DATA_DIR: process.env.TMPDIR + "/app-data" }, stdio: "ignore" });
  for (let i = 0; i < 300 && !(existsSync(appPid) && readFileSync(appPid, "utf8")); i++) await new Promise((r) => setTimeout(r, 20));
  writeFileSync(process.env.STUB_LOG + "." + kind + ".launched", "");
}
if (kind === "prep") {
  const { mkdirSync } = await import("node:fs");
  const out = args[args.indexOf("--out") + 1];
  mkdirSync(out + "/rc/bundle", { recursive: true });
  writeFileSync(out + "/rc/bundle/main.jsbundle", "candidate bundle");
}
const wait = +(process.env["STUB_SLEEP_" + env] ?? 0);
setTimeout(() => {
  writeFileSync(process.env.STUB_LOG + "." + kind + ".finished", "");
  process.exit(+(process.env["STUB_EXIT_" + env] ?? 0));
}, wait);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gate-sh-"));
  const perf = join(dir, "perf");
  mkdirSync(perf);
  for (const name of ["native-bench", "ratchet", "gate-verdict"]) writeFileSync(join(perf, `${name}.mjs`), stub(name));
  const smoke = join(dir, "smoke.sh");
  writeFileSync(smoke, `#!/bin/sh\necho '["smoke",[]]' >> "$STUB_LOG"\necho $$ > "$STUB_LOG.smoke.pid"\nsleep "\${STUB_SLEEP_smoke_SECS:-0}"\nexit "\${STUB_EXIT_smoke:-0}"\n`);
  chmodSync(smoke, 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const env = { ...process.env, GATE_LOCKED: "1", GATE_TMP_ROOT: dir, GATE_ROOT: dir, GATE_PERF: perf, GATE_SMOKE: smoke, STUB_LOG: log, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const spawned = [];
  const extra = [];
  const done = () => {
    for (const pid of extra) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (const child of spawned) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    for (const name of readdirSync(dir)) {
      if (!/^calls\.log\..*\.(pid|app)$/.test(name)) continue;
      const pid = +readFileSync(join(dir, name), "utf8");
      if (!(pid > 0)) continue;
      const command = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      if (command.includes(dir)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, env, log, calls, out: join(dir, "out"), spawned, extra, done };
}

const run = (s, extra = {}) => spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...s.env, ...extra }, encoding: "utf8", timeout: 60_000 });

test("every step passing runs two rounds in two new folders and exits with the verdict's 0", () => {
  const s = setup();
  try {
    const r = run(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = s.calls();
    assert.deepEqual(calls.map(([k]) => k).sort(), ["gate-verdict", "native-bench", "native-bench", "prep", "ratchet", "smoke"]);
    const rounds = calls.filter(([k]) => k === "native-bench").map(([, a]) => a[a.indexOf("--out") + 1]);
    assert.equal(new Set(rounds).size, 2);
    assert.ok(calls.filter(([k]) => k === "native-bench").every(([, a]) => a.includes("launch,session,windows")));
    const verdict = calls.find(([k]) => k === "gate-verdict")[1];
    assert.deepEqual(verdict.slice(-2), rounds);
  } finally {
    s.done();
  }
});

test("a FAIL or INVALID verdict is the block's exit status, not cleanup's", () => {
  for (const code of ["1", "2"]) {
    const s = setup();
    try {
      assert.equal(run(s, { STUB_EXIT_gate_verdict: code }).status, +code);
    } finally {
      s.done();
    }
  }
});

test("a failed round stops the gate with its code (13 for round 1), before the second round and the verdict", () => {
  const s = setup();
  try {
    const r = run(s, { STUB_EXIT_native_bench: "3" });
    assert.equal(r.status, 13);
    assert.match(r.stdout, /round 1 failed \(status 3/);
    const kinds = s.calls().map(([k]) => k);
    assert.equal(kinds.filter((k) => k === "native-bench").length, 1);
    assert.ok(!kinds.includes("gate-verdict"));
  } finally {
    s.done();
  }
});

test("a failed prep job waits for the others, then exits with the first failed step's code (11 ratchet) and no round", () => {
  const s = setup();
  try {
    const r = run(s, { STUB_EXIT_ratchet: "5", STUB_EXIT_prep: "6" });
    assert.equal(r.status, 11);
    assert.ok(!s.calls().some(([k]) => k === "native-bench"));
    assert.match(r.stdout, /smoke 0, ratchet 5, prepare 6/);
  } finally {
    s.done();
  }
});

test("a TERM stops the prep jobs it started and waits for them, and exits 143", async () => {
  const s = setup();
  try {
    const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...s.env, STUB_SLEEP_ratchet: "20000", STUB_SLEEP_prep: "20000", GATE_JOB_INT_SECS: "2" }, stdio: "ignore" }); s.spawned.push(child);
    for (const end = Date.now() + 10_000; Date.now() < end && s.calls().length < 3; ) await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.calls().length, 3);
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(code, 143);
    assert.ok(Date.now() - t0 < 10_000);
    assert.ok(!existsSync(`${s.log}.ratchet.finished`) && !existsSync(`${s.log}.prep.finished`));
  } finally {
    s.done();
  }
});

test("without the lock it fails at once with the lock's status", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, "scripts", "agent"), { recursive: true });
    writeFileSync(join(s.dir, "scripts", "agent", "locked"), "#!/bin/sh\necho 'perflab is held' >&2\nexit 75\n");
    chmodSync(join(s.dir, "scripts", "agent", "locked"), 0o755);
    const r = run(s, { GATE_LOCKED: "" });
    assert.equal(r.status, 75);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.done();
  }
});

test("a pass keeps the candidate's bench bundle in dist/<version>/bench for the next gate; a FAIL keeps nothing", () => {
  const s = setup();
  try {
    assert.equal(run(s).status, 0);
    assert.equal(readFileSync(join(s.dir, "dist", "0.2.49", "bench", "main.jsbundle"), "utf8"), "candidate bundle");
  } finally {
    s.done();
  }
  const f = setup();
  try {
    assert.equal(run(f, { STUB_EXIT_gate_verdict: "1" }).status, 1);
    assert.equal(existsSync(join(f.dir, "dist", "0.2.49", "bench")), false);
  } finally {
    f.done();
  }
});

test("a pass whose bundle can't be kept exits 70, not 0", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, "dist", "0.2.49"), { recursive: true });
    writeFileSync(join(s.dir, "dist", "0.2.49", "bench"), "a file in the way");
    assert.equal(run(s).status, 70);
  } finally {
    s.done();
  }
});

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

function withRealLock(s) {
  const real = join(dirname(gate), "../../../../scripts/agent/locked");
  mkdirSync(join(s.dir, "scripts", "agent"), { recursive: true });
  writeFileSync(join(s.dir, "scripts", "agent", "locked"), readFileSync(real));
  chmodSync(join(s.dir, "scripts", "agent", "locked"), 0o755);
  const locks = join(s.dir, "locks");
  mkdirSync(locks);
  return { ...s.env, GATE_LOCKED: "", GATE_LOCK_WAIT: "20", AC_LOCK_ROOT: locks, GATE_TMP_ROOT: s.dir, AC_LOCKED_AS: "", AC_LOCKED_HELD: "", GATE_JOB_INT_SECS: "1", GATE_JOB_TERM_SECS: "5", GATE_CHAIN_TERM_SECS: "60" };
}

for (const [how, signal, group, code] of [["TERM to its pid", "SIGTERM", false, 143], ["INT to its process group", "SIGINT", true, 130], ["TERM to its process group", "SIGTERM", true, 143]]) {
  test(`through the real lock, ${how} stops every job before the lock is free, and returns after`, async () => {
    const s = setup();
    try {
      const env = withRealLock(s);
      const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...env, STUB_SLEEP_smoke_SECS: "60", STUB_SLEEP_ratchet: "60000", STUB_SLEEP_prep: "60000", STUB_IGNORE_INT_ratchet: "1" }, stdio: "ignore", detached: true }); s.spawned.push(child);
      const exited = new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
      const pidFile = (k) => `${s.log}.${k}.pid`;
      for (const end = Date.now() + 20_000; Date.now() < end && !["smoke", "ratchet", "prep"].every((k) => existsSync(pidFile(k))); ) await new Promise((r) => setTimeout(r, 50));
      const pids = ["smoke", "ratchet", "prep"].map((k) => +readFileSync(pidFile(k), "utf8"));
      assert.ok(pids.every(alive));
      const held = () => existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock"));
      assert.ok(held());
      if (group) process.kill(-child.pid, signal);
      else child.kill(signal);
      let done = false, unheldWhileRunning = 0;
      exited.then(() => (done = true));
      while (!done) {
        if (pids.some(alive) && !held()) unheldWhileRunning++;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(await exited, code);
      assert.equal(unheldWhileRunning, 0);
      assert.deepEqual(pids.filter(alive), []);
      assert.ok(!held());
      const again = spawnSync(join(s.dir, "scripts", "agent", "locked"), ["perflab", "--wait", "3", "--", "true"], { env, encoding: "utf8" });
      assert.equal(again.status, 0, again.stderr);
    } finally {
      s.done();
    }
  });
}

test("through the real lock, a step's 76 or 77 is the gate's own code, not the lock's 75 or a rerun", () => {
  for (const code of ["76", "77"]) {
    const s = setup();
    try {
      const r = spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...withRealLock(s), STUB_EXIT_ratchet: code }, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 11, r.stdout + r.stderr);
      assert.equal(s.calls().filter(([k]) => k === "ratchet").length, 1);
      assert.match(r.stdout, new RegExp(`the ratchet failed \\(status ${code}`));
    } finally {
      s.done();
    }
  }
});

test("through the real lock, a busy lock fails fast with 75 and starts nothing", () => {
  const s = setup();
  try {
    const env = { ...withRealLock(s), GATE_LOCK_WAIT: "2" };
    const holder = spawn(join(s.dir, "scripts", "agent", "locked"), ["perflab", "--wait", "5", "--", "sleep", "20"], { env, stdio: "ignore", detached: true });
    s.spawned.push(holder);
    for (const end = Date.now() + 5000; Date.now() < end && !existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock")); ) spawnSync("sleep", ["0.05"]);
    const r = spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env, encoding: "utf8", timeout: 60_000 });
    holder.kill("SIGTERM");
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.done();
  }
});

test("through the real lock, a TERM while the jobs are still starting still stops every one of them", async () => {
  for (let i = 0; i < 3; i++) {
    const s = setup();
    try {
      const env = withRealLock(s);
      const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...env, STUB_SLEEP_smoke_SECS: "60", STUB_SLEEP_ratchet: "60000", STUB_SLEEP_prep: "60000" }, stdio: "ignore", detached: true }); s.spawned.push(child);
      const exited = new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
      for (const end = Date.now() + 20_000; Date.now() < end && !existsSync(`${s.log}.smoke.pid`); ) await new Promise((r) => setTimeout(r, 5));
      child.kill("SIGTERM");
      assert.equal(await exited, 143);
      await new Promise((r) => setTimeout(r, 500));
      const started = ["smoke", "ratchet", "prep"].filter((k) => existsSync(`${s.log}.${k}.pid`)).map((k) => +readFileSync(`${s.log}.${k}.pid`, "utf8")).filter((p) => p > 0);
      assert.deepEqual(started.filter(alive), []);
      assert.ok(!existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock")));
    } finally {
      s.done();
    }
  }
});

const appGone = async (pid, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end && alive(pid); ) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

function ownersArdia(s, name = "owner", dataDir = join(s.dir, "owner-data")) {
  const pidfile = join(s.dir, `${name}.pid`), log = join(s.dir, `${name}.signals`);
  spawnSync(process.execPath, ["-e", LAUNCHER, APP, pidfile, log], { env: { PATH: process.env.PATH, ARDIA_DATA_DIR: dataDir, HOME: process.env.HOME }, stdio: "ignore" });
  for (let i = 0; i < 300 && !(existsSync(pidfile) && readFileSync(pidfile, "utf8")); i++) spawnSync("sleep", ["0.02"]);
  const pid = +readFileSync(pidfile, "utf8");
  s.extra.push(pid);
  return { pid, signals: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

for (const [how, act, code] of [
  ["INT to its process group", (child) => process.kill(-child.pid, "SIGINT"), 130],
  ["TERM to its pid", (child) => child.kill("SIGTERM"), 143],
  ["a prep timeout", null, 12],
  ["a normal end", null, 0],
]) {
  test(`through the real lock, after ${how} the app a bench launched like open is gone before the lock is free, and no other instance is signalled: the owner's Ardia, one beside <out>, one inside <out> but outside the gate's folders`, async () => {
    const s = setup();
    try {
      const owner = ownersArdia(s);
      const sibling = ownersArdia(s, "sibling", join(s.dir, "another-agent", "data", "launch-1"));
      mkdirSync(join(s.out, "someone-else"), { recursive: true });
      const insideOut = ownersArdia(s, "inside-out", join(s.out, "someone-else", "data"));
      const normal = code === 0;
      const env = { ...withRealLock(s), STUB_APP_prep: "1", STUB_SLEEP_prep: act ? "60000" : normal ? "1500" : "60000", STUB_SLEEP_smoke_SECS: act ? "60" : "0", STUB_SLEEP_ratchet: act ? "60000" : "0", GATE_APP_QUIT_SECS: "2", ...(code === 12 ? { GATE_PREP_TIMEOUT: "3" } : {}) };
      const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env, stdio: "ignore", detached: true });
      s.spawned.push(child);
      const exited = new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
      for (const end = Date.now() + 20_000; Date.now() < end && !existsSync(`${s.log}.prep.launched`); ) await new Promise((r) => setTimeout(r, 50));
      const app = +readFileSync(`${s.log}.prep.app`, "utf8");
      assert.ok(alive(app));
      assert.ok(parentOf(app) > 0 && parentOf(app) !== child.pid && parentOf(app) !== process.pid);
      const held = () => existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock"));
      if (act) act(child);
      let done = false, unheld = 0;
      exited.then(() => (done = true));
      while (!done) {
        if (alive(app) && !held()) unheld++;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(await exited, code);
      assert.equal(unheld, 0);
      assert.ok(await appGone(app, 500));
      assert.ok(!held());
      for (const decoy of [owner, sibling, insideOut]) {
        assert.ok(alive(decoy.pid));
        assert.deepEqual(decoy.signals(), []);
      }
      assert.deepEqual(readdirSync(s.out).filter((n) => n.startsWith(".run.")), []);
    } finally {
      s.done();
    }
  });
}

test("when an app it launched can't be stopped, the gate exits 71 whatever the verdict, and keeps its run folder", () => {
  const s = setup();
  try {
    const fake = join(s.dir, "sweep-fails.mjs");
    writeFileSync(fake, `console.log("bench-sweep: still running: 1"); process.exit(1);`);
    const r = spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...withRealLock(s), GATE_SWEEP: fake }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 71, r.stdout + r.stderr);
    assert.match(r.stdout, /still running; kept/);
    assert.equal(readdirSync(s.out).filter((n) => n.startsWith(".run.")).length, 1);
  } finally {
    s.done();
  }
});

test("a TERM that lands while the lock chain is still starting returns the signal's status, never the launch failure's 12", async () => {
  for (let i = 0; i < 6; i++) {
    const s = setup();
    try {
      const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: withRealLock(s), stdio: "ignore", detached: true });
      s.spawned.push(child);
      const exited = new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
      await new Promise((r) => setTimeout(r, 30 + i * 15));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const code = await exited;
      assert.ok([143, "SIGTERM"].includes(code), `exit ${code}`);
    } finally {
      s.done();
    }
  }
});

test("a second gate with the same out folder leaves the running gate's run folder alone, and the running gate still cancels cleanly", async () => {
  const s = setup();
  try {
    const env = { ...withRealLock(s), STUB_SLEEP_smoke_SECS: "60", STUB_SLEEP_ratchet: "60000", STUB_SLEEP_prep: "60000" };
    const first = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env, stdio: "ignore", detached: true }); s.spawned.push(first);
    const firstExit = new Promise((r) => first.on("exit", (c, sig) => r(c ?? sig)));
    for (const end = Date.now() + 20_000; Date.now() < end && !["smoke", "ratchet", "prep"].every((k) => existsSync(`${s.log}.${k}.pid`)); ) await new Promise((r) => setTimeout(r, 50));
    const runs = () => readdirSync(s.out).filter((n) => n.startsWith(".run."));
    const [firstRun] = runs();
    const worker = readFileSync(join(s.out, firstRun, "worker.pid"), "utf8");
    const second = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...env, GATE_LOCK_WAIT: "30" }, stdio: "ignore", detached: true }); s.spawned.push(second);
    const secondExit = new Promise((r) => second.on("exit", (c, sig) => r(c ?? sig)));
    for (const end = Date.now() + 5000; Date.now() < end && runs().length < 2; ) await new Promise((r) => setTimeout(r, 50));
    assert.equal(runs().length, 2);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(readFileSync(join(s.out, firstRun, "worker.pid"), "utf8"), worker);
    const pids = ["smoke", "ratchet", "prep"].map((k) => +readFileSync(`${s.log}.${k}.pid`, "utf8"));
    first.kill("SIGTERM");
    assert.equal(await firstExit, 143);
    assert.deepEqual(pids.filter(alive), []);
    for (const end = Date.now() + 10_000; Date.now() < end && !existsSync(join(s.out, runs().find((r) => r !== firstRun), "worker.pid")); ) await new Promise((r) => setTimeout(r, 50));
    process.kill(-second.pid, "SIGINT");
    assert.equal(await secondExit, 130);
  } finally {
    s.done();
  }
});
