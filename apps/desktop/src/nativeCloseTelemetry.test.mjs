import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_DRAIN_METHOD, endSessionAtNativeClose, otherOpenWindows } from "./nativeCloseTelemetry.ts";
import { quitEndingTelemetry } from "./quit.ts";

function host({ drains = false, windowId = "main" } = {}) {
  const closers = new Set();
  const invoked = [];
  let quitFails = false;
  return {
    closers,
    invoked,
    failQuit: () => void (quitFails = true),
    close: () => { for (const closer of [...closers]) closer(); },
    bootstrap: { windowId, profileId: "default", capabilities: drains ? [CLOSE_DRAIN_METHOD] : [] },
    call: async () => "null",
    invoke: async (method) => {
      invoked.push(method);
      if (quitFails) throw new Error("the shell refused to quit");
      return null;
    },
    onEvent: () => () => {},
    onBeforeClose: (listener) => { closers.add(listener); return () => closers.delete(listener); },
  };
}

test("only regular windows other than the closing one keep the session going", () => {
  assert.equal(otherOpenWindows(["main"], "main"), 0);
  assert.equal(otherOpenWindows(["main", "settings", "import"], "main"), 0);
  assert.equal(otherOpenWindows(["main", "w2"], "main"), 1);
  assert.equal(otherOpenWindows(["w2"], "main"), 1);
});

test("on a host that closes windows without the drain protocol, the leading last window ends the session as it closes, once", () => {
  const shell = host();
  let ended = 0;
  let leading = true;
  let order = ["main", "w2"];
  endSessionAtNativeClose({ host: shell, windowId: "main", leading: () => leading, windowOrder: () => order, end: () => ended++ });
  shell.close();
  assert.equal(ended, 0, "another window is still open, so the session goes on");
  order = ["main"];
  leading = false;
  shell.close();
  assert.equal(ended, 0, "a window that doesn't lead telemetry leaves the session to the leader");
  leading = true;
  shell.close();
  assert.equal(ended, 1);
});

test("a host with the drain protocol, a utility window or a host without close hooks never ends the session at close", () => {
  for (const [shell, windowId] of [[host({ drains: true }), "main"], [host({ windowId: "settings" }), "settings"]]) {
    let ended = 0;
    endSessionAtNativeClose({ host: shell, windowId, leading: () => true, windowOrder: () => [windowId], end: () => ended++ });
    shell.close();
    assert.equal(ended, 0);
    assert.equal(shell.closers.size, 0);
  }
  const bare = host();
  delete bare.onBeforeClose;
  assert.equal(typeof endSessionAtNativeClose({ host: bare, windowId: "main", leading: () => true, windowOrder: () => ["main"], end: () => assert.fail("no hook to end from") }), "function");
});

test("quitting a host without the drain protocol ends the telemetry session before the shell quits, and reopens it when the quit fails", async () => {
  const shell = host();
  const steps = [];
  const settle = async (endsSession) => { steps.push(`settle ${endsSession}`); return "token-1"; };
  const reopen = async (token) => void steps.push(`reopen ${token}`);
  await quitEndingTelemetry(shell, settle, reopen);
  assert.deepEqual(steps, ["settle true"]);
  assert.deepEqual(shell.invoked, ["ArdiaShell.quit"]);
  shell.failQuit();
  await assert.rejects(quitEndingTelemetry(shell, settle, reopen), /refused to quit/);
  assert.deepEqual(steps, ["settle true", "settle true", "reopen token-1"]);
  const failing = host();
  await quitEndingTelemetry(failing, async () => { throw new Error("leader gone"); }, reopen);
  assert.deepEqual(failing.invoked, ["ArdiaShell.quit"], "a telemetry failure never blocks quitting");
});

test("quitting a host with the drain protocol leaves the session to the window close drain", async () => {
  const shell = host({ drains: true });
  await quitEndingTelemetry(shell, async () => assert.fail("the drain settles telemetry"), async () => assert.fail("nothing to reopen"));
  assert.deepEqual(shell.invoked, ["ArdiaShell.quit"]);
});
