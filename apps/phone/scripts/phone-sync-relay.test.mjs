import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stopRelayProcess } from "./phone-sync-relay.mjs";

const relay = join(dirname(fileURLToPath(import.meta.url)), "phone-sync-relay.mjs");
const skip = (process.platform === "win32" || process.getuid?.() === 0) && "needs a non-root Unix user, so pid 1 belongs to someone else";

function savedRelay(t, saved) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "relay-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = join(base, "work");
  mkdirSync(work);
  writeFileSync(join(work, "relay.json"), JSON.stringify(saved));
  return { base, work };
}
const runRelay = (...args) => spawnSync(process.execPath, [relay, ...args], { encoding: "utf8", timeout: 20_000 });

test("a saved relay pid now owned by another user reads as not running, and stop still clears the state", { skip }, (t) => {
  const { work } = savedRelay(t, { pid: 1, every: 3 });
  const status = runRelay("status", "--work", work);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^relay not running;/);

  const stop = runRelay("stop", "--work", work);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /relay stopped/);
  assert.equal(existsSync(work), false);
});

test("start isn't refused by a saved relay pid that another user's process took over", { skip }, (t) => {
  const { base, work } = savedRelay(t, { pid: 1, every: 3 });
  mkdirSync(join(base, "mac"));
  const start = runRelay("start", "--work", work, "--mac", join(base, "mac"), "--adb", "/usr/bin/false");
  assert.notEqual(start.status, 0);
  assert.doesNotMatch(start.stderr, /a relay already runs/);
});

test("the relay runs as a single copied file, as docs/phone.md deploys it", (t) => {
  const { base, work } = savedRelay(t, { every: 3 });
  const alone = join(base, "phone-sync-relay.mjs");
  copyFileSync(relay, alone);
  const status = spawnSync(process.execPath, [alone, "status", "--work", work], { encoding: "utf8", timeout: 20_000, cwd: base });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^relay not running;/);
});

test("stop keeps the relay's state when its relay can't be signalled to stop", () => {
  const refusing = (code) => (pid, sig) => {
    if (sig === "SIGTERM") throw Object.assign(new Error(code), { code });
  };
  assert.match(stopRelayProcess(4242, refusing("EPERM")), /could not stop the relay \(pid 4242\): EPERM/);
  assert.equal(stopRelayProcess(4242, refusing("ESRCH")), null);
  assert.equal(stopRelayProcess(4242, () => {}), null);
  assert.equal(stopRelayProcess(undefined, () => {}), null);
  assert.equal(
    stopRelayProcess(4242, () => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }),
    null,
  );
});
