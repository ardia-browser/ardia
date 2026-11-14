import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { dbusDaemonAvailable, fakeLogind, fakeScreenSaver, privateBus } from "../testing/dbus.ts";

const scratch = mkdtempSync(join(tmpdir(), "ardia-screen-lock-"));
const buses = dbusDaemonAvailable() ? await Promise.all([privateBus(), privateBus()]) : null;
process.env.DBUS_SYSTEM_BUS_ADDRESS = `unix:path=${join(scratch, "not-this-system-bus")}`;
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(scratch, "not-this-session-bus")}`;
after(() => {
  for (const bus of buses ?? []) bus.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const { watchSessionLock } = await import("./screenLock.ts");

const MY_PID = 4242;
const nowhere = (name: string) => `unix:path=${join(scratch, name)}`;

function recorder() {
  const seen: string[] = [];
  return {
    seen,
    onLock: (source: string) => void seen.push(source),
    async until(count: number) {
      const deadline = performance.now() + 5_000;
      while (seen.length < count) {
        if (performance.now() > deadline) throw new Error(`only ${seen.length} of ${count} locks arrived`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 150)),
  };
}

test("with no session id the session is found by pid, and only its own Lock and LockedHint count", { skip: !buses }, async () => {
  const logind = await fakeLogind(buses![0].address, { [MY_PID]: "mine", 1: "theirs" });
  const locks = recorder();
  const watch = await watchSessionLock(locks.onLock, { systemBus: buses![0].address, sessionBus: buses![1].address, sessionId: "", pid: MY_PID });
  try {
    assert.deepEqual(watch.sources, ["logind", "screenSaver"]);
    assert.ok(logind.calls.includes(`GetSessionByPID(${MY_PID})`));
    logind.lock("theirs");
    logind.lockedHint("theirs", true);
    logind.lockedHint("mine", false);
    await locks.settle();
    assert.deepEqual(locks.seen, []);
    logind.lock("mine");
    await locks.until(1);
    logind.lockedHint("mine", true);
    await locks.until(2);
    assert.deepEqual(locks.seen, ["logind", "logind"]);
  } finally {
    watch.stop();
    logind.connection.close();
  }
});

test("each desktop's screen saver turning on counts as a lock, and turning off doesn't", { skip: !buses }, async () => {
  const savers = await Promise.all([
    fakeScreenSaver(buses![1].address, "org.freedesktop.ScreenSaver", "/ScreenSaver"),
    fakeScreenSaver(buses![1].address, "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
    fakeScreenSaver(buses![1].address, "org.xfce.ScreenSaver", "/org/xfce/ScreenSaver"),
  ]);
  const locks = recorder();
  const watch = await watchSessionLock(locks.onLock, { systemBus: nowhere("no-system"), sessionBus: buses![1].address });
  try {
    assert.deepEqual(watch.sources, ["screenSaver"]);
    assert.equal(watch.failures.length, 1);
    for (const saver of savers) saver.active(false);
    await locks.settle();
    assert.deepEqual(locks.seen, []);
    for (const [index, saver] of savers.entries()) {
      saver.active(true);
      await locks.until(index + 1);
    }
    assert.deepEqual(locks.seen, ["screenSaver", "screenSaver", "screenSaver"]);
  } finally {
    watch.stop();
    for (const saver of savers) saver.connection.close();
  }
});

test("a system bus without logind still leaves the screen savers watched", { skip: !buses }, async () => {
  const locks = recorder();
  const watch = await watchSessionLock(locks.onLock, { systemBus: buses![0].address, sessionBus: buses![1].address, sessionId: "1" });
  try {
    assert.deepEqual(watch.sources, ["screenSaver"]);
    assert.match(watch.failures[0]!, /^logind: /);
  } finally {
    watch.stop();
  }
});

test("missing buses, or a bus that never answers, give up quietly instead of throwing or hanging", async () => {
  const silent = createServer(() => undefined).listen(join(scratch, "silent"));
  try {
    const started = performance.now();
    const watch = await watchSessionLock(() => undefined, { systemBus: nowhere("no-system"), sessionBus: nowhere("silent"), connectDeadlineMs: 300 });
    assert.deepEqual(watch.sources, []);
    assert.equal(watch.failures.length, 2);
    assert.ok(performance.now() - started < 2_000);
    watch.stop();
  } finally {
    silent.close();
  }
});
