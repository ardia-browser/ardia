import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { answerSessionEnds, SESSION_ENDED_METHOD } from "./sessionEndHandshake.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const bootstrap = readFileSync(join(REPO, "engine/ardiacore-linux/src/ardia/linux/bootstrap.js"), "utf8");

function nativeShell({ capabilities = [SESSION_ENDED_METHOD] } = {}) {
  const sent = [];
  const pageListeners = new Map();
  const context = {
    location: { protocol: "chrome:", hostname: "ardia" },
    crypto: { randomUUID },
    __ardiaBootstrap: { windowId: "main", profileId: "default", capabilities },
    setTimeout, clearTimeout, console,
    addEventListener: (type, listener) => pageListeners.set(type, listener),
    chrome: { send(_name, [requestId, kind, request]) {
      sent.push(kind === "host.invoke" ? { method: request.method, args: request.args.args } : { call: request.name });
      queueMicrotask(() => context.__ardiaReply(requestId, true, null));
    } },
  };
  context.window = context;
  context.top = context;
  runInNewContext(bootstrap, context);
  return {
    host: context.__ardiaHost,
    sent,
    emit: (name, data) => context.__ardiaEvent("ArdiaShell", "shell", { name, data }),
    hide: () => pageListeners.get("pagehide")(),
  };
}

const settled = async () => {
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("the shared bootstrap drops every native request made after pagehide, which is why the session can't end from a close listener", async () => {
  const shell = nativeShell();
  let lateWrite;
  shell.host.onBeforeClose(() => { lateWrite = Promise.resolve().then(() => shell.host.invoke("ArdiaShell.writeDocument", { args: ["telemetry.json", "{}"] })); });
  shell.hide();
  await assert.rejects(lateWrite, /The browser UI has closed/);
  assert.deepEqual(shell.sent, []);
});

test("asked by the native shell before it closes the last window, the UI ends the telemetry session through the live bridge and then acknowledges the token", async () => {
  const shell = nativeShell();
  const steps = [];
  answerSessionEnds({
    host: shell.host,
    settle: async (endsSession) => {
      steps.push(`settle ${endsSession}`);
      await shell.host.invoke("ArdiaShell.writeDocument", { args: ["telemetry.json", '{"sessionOpen":false}'] });
      return "end-1";
    },
    reopen: async (token) => void steps.push(`reopen ${token}`),
    report: (error) => assert.fail(String(error)),
  });
  shell.emit("shell.sessionEnding", { token: "native-1" });
  await settled();
  assert.deepEqual(steps, ["settle true"]);
  assert.deepEqual(shell.sent, [
    { method: "ArdiaShell.writeDocument", args: ["telemetry.json", '{"sessionOpen":false}'] },
    { method: SESSION_ENDED_METHOD, args: ["native-1"] },
  ], "the state write reaches the host before the acknowledgement that lets the window close");
  shell.emit("shell.sessionResumed", { token: "native-1" });
  await settled();
  assert.deepEqual(steps, ["settle true", "reopen end-1"], "a cancelled quit reopens the session this window ended");
  shell.emit("shell.sessionResumed", { token: "native-1" });
  await settled();
  assert.deepEqual(steps, ["settle true", "reopen end-1"], "the session reopens once");
});

test("a failed settle still acknowledges, so the native close never waits past its deadline for the UI", async () => {
  const shell = nativeShell();
  const reported = [];
  answerSessionEnds({ host: shell.host, settle: async () => { throw new Error("no leader"); }, reopen: async () => assert.fail("nothing ended"), report: (error) => reported.push(String(error.message)) });
  shell.emit("shell.sessionEnding", { token: "native-2" });
  await settled();
  assert.deepEqual(shell.sent, [{ method: SESSION_ENDED_METHOD, args: ["native-2"] }]);
  assert.deepEqual(reported, ["no leader"]);
  shell.emit("shell.sessionResumed", { token: "native-2" });
  await settled();
});

test("a host without the handshake, other shell events and events without a token are left alone", async () => {
  const plain = nativeShell({ capabilities: [] });
  answerSessionEnds({ host: plain.host, settle: async () => assert.fail("no handshake on this host"), reopen: async () => {}, report: () => {} });
  plain.emit("shell.sessionEnding", { token: "native-3" });
  const shell = nativeShell();
  answerSessionEnds({ host: shell.host, settle: async () => assert.fail("not a session end"), reopen: async () => {}, report: () => {} });
  shell.emit("shell.closeRequested", { token: "native-4" });
  shell.emit("shell.sessionEnding", {});
  shell.emit("shell.sessionEnding", null);
  await settled();
  assert.deepEqual([...plain.sent, ...shell.sent], []);
});

test("the Windows shell's session-end state machine asks once, joins later closes, and resumes only a cancelled quit", (t) => {
  const compiler = ["c++", "clang++", "g++"].find((name) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
  if (!compiler) {
    if (process.env.CI && process.platform !== "win32") assert.fail("no C++ compiler to build scripts/windows/engine/tests/webui_session_end_policy_test.cc");
    return t.skip("no C++ compiler");
  }
  const scratch = mkdtempSync(join(tmpdir(), "ardia-session-end-"));
  try {
    const binary = join(scratch, "webui_session_end_policy_test");
    const build = spawnSync(compiler, ["-std=c++20", "-Wall", "-Wextra", "-I", join(REPO, "scripts/windows/engine/src"), join(REPO, "scripts/windows/engine/tests/webui_session_end_policy_test.cc"), "-o", binary], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /all assertions passed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the Windows shell advertises the acknowledgement, routes it through the token check, and holds the last window's close and every quit for it", () => {
  const read = (file) => readFileSync(join(REPO, "scripts/windows/engine/src/ardia/win/webui", file), "utf8");
  const calls = read("webui_host_calls.cc");
  const capabilities = calls.slice(calls.indexOf("kBrowserWindowCapabilities[] = {"), calls.indexOf("};", calls.indexOf("kBrowserWindowCapabilities[] = {")));
  assert.match(capabilities, /webui_window::kSessionEndedCall/);
  assert.match(read("webui_session_end_policy.h"), /kSessionEndedCall\[\] = "ArdiaShell\.sessionEnded"/);
  assert.match(calls, /method == webui_window::kSessionEndedCall[\s\S]{0,400}ValidSessionToken\(token\)[\s\S]{0,300}SessionEndAcknowledged\(token\)/);
  assert.match(calls, /"ArdiaShell\.quit"[\s\S]{0,200}EndSessionThen\(this, base::BindOnce\(&QuitEverything\)\)/);
  assert.doesNotMatch(calls, /base::BindOnce\(&QuitEverything\)\);\n  }\n  if \(method == "ArdiaShell\.focusWindow"/, "the update restart quits through the session end too");
  const view = read("webui_host_view.cc");
  const requestClose = view.slice(view.indexOf("void ShellHostView::RequestClose()"), view.indexOf("bool ShellHostView::InterceptSystemClose()"));
  assert.doesNotMatch(requestClose.slice(0, requestClose.indexOf("void ShellHostView::CommitClose()")), /GetWindow\(\)->Close\(\)/, "RequestClose closes only through CommitClose");
  assert.match(requestClose, /ClosingEndsSession\([\s\S]{0,80}OpenBrowserWindowsBesides\(this\)\)[\s\S]{0,400}EndSessionThen\(/);
});
