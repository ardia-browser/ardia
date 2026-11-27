import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { answerSessionEnds, SESSION_ENDED_METHOD } from "./sessionEndHandshake.ts";
import { createResumeRule } from "./telemetrySettle.ts";
import { continuesSession } from "./telemetryContinuation.ts";

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

test("asked by the native shell before it closes the last window, the UI ends the telemetry session through the live bridge, naming the host's token as the cause, and then acknowledges it", async () => {
  const shell = nativeShell();
  const steps = [];
  answerSessionEnds({
    host: shell.host,
    settle: async (endsSession, cause) => {
      steps.push(`settle ${endsSession} ${cause}`);
      await shell.host.invoke("ArdiaShell.writeDocument", { args: ["telemetry.json", '{"sessionOpen":false}'] });
      return "end-1";
    },
    resume: async (cause) => void steps.push(`resume ${cause}`),
    report: (error) => assert.fail(String(error)),
  });
  shell.emit("shell.sessionEnding", { token: "native-1" });
  await settled();
  assert.deepEqual(steps, ["settle true native-1"]);
  assert.deepEqual(shell.sent, [
    { method: "ArdiaShell.writeDocument", args: ["telemetry.json", '{"sessionOpen":false}'] },
    { method: SESSION_ENDED_METHOD, args: ["native-1"] },
  ], "the state write reaches the host before the acknowledgement that lets the window close");
  shell.emit("shell.sessionResumed", { token: "native-1" });
  await settled();
  assert.deepEqual(steps, ["settle true native-1", "resume native-1"], "a cancelled quit asks the telemetry leader to resume the session that token ended");
});

test("a failed or timed-out settle still acknowledges, and a later resume still reaches the leader, so the session the leader did end reopens", async () => {
  const shell = nativeShell();
  const reported = [];
  const resumed = [];
  answerSessionEnds({ host: shell.host, settle: async () => { throw new Error("the leader didn't answer in time"); }, resume: async (cause) => void resumed.push(cause), report: (error) => reported.push(String(error.message)) });
  shell.emit("shell.sessionEnding", { token: "native-2" });
  await settled();
  assert.deepEqual(shell.sent, [{ method: SESSION_ENDED_METHOD, args: ["native-2"] }]);
  assert.deepEqual(reported, ["the leader didn't answer in time"]);
  shell.emit("shell.sessionResumed", { token: "native-2" });
  await settled();
  assert.deepEqual(resumed, ["native-2"]);
});

test("a window that never saw the end, such as a reloaded or surviving one, passes the host's resume on to the leader", async () => {
  const shell = nativeShell();
  const resumed = [];
  answerSessionEnds({ host: shell.host, settle: async () => assert.fail("this window wasn't asked"), resume: async (cause) => void resumed.push(cause), report: (error) => assert.fail(String(error)) });
  shell.emit("shell.sessionResumed", { token: "native-5" });
  await settled();
  assert.deepEqual(resumed, ["native-5"]);
});

test("a host without the handshake, other shell events and events without a well-formed token are left alone", async () => {
  const plain = nativeShell({ capabilities: [] });
  answerSessionEnds({ host: plain.host, settle: async () => assert.fail("no handshake on this host"), resume: async () => assert.fail("no handshake on this host"), report: () => {} });
  plain.emit("shell.sessionEnding", { token: "native-3" });
  plain.emit("shell.sessionResumed", { token: "native-3" });
  const shell = nativeShell();
  answerSessionEnds({ host: shell.host, settle: async () => assert.fail("not a session end"), resume: async () => assert.fail("not a resume"), report: () => {} });
  shell.emit("shell.closeRequested", { token: "native-4" });
  for (const data of [{}, null, { token: "" }, { token: 7 }, { token: "has space" }, { token: "x".repeat(65) }, { token: "<script>" }]) {
    shell.emit("shell.sessionEnding", data);
    shell.emit("shell.sessionResumed", data);
  }
  await settled();
  assert.deepEqual([...plain.sent, ...shell.sent], []);
});

test("the leader resumes only an ended session, only for the token that ended it, once, and trusts the host's token when the end's cause was lost with a reloaded renderer", () => {
  const rule = createResumeRule();
  assert.equal(rule.resumes(false, "native-1"), false, "a session that never ended stays as it is");
  rule.ended("native-1");
  assert.equal(rule.resumes(true, "native-2"), false, "an unrelated token is refused");
  assert.equal(rule.resumes(true, ""), false);
  assert.equal(rule.resumes(true, undefined), false);
  assert.equal(rule.resumes(true, "native-1"), true);
  assert.equal(rule.resumes(false, "native-1"), false, "a resumed session isn't resumed twice");
  rule.ended(undefined);
  assert.equal(rule.resumes(true, "native-9"), true, "an end with no cause, as after a reload, takes the host's word");
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

function windowsProcess() {
  const steps = new Set();
  const STEPS = ["version", "versionUpdated", "onboarding", "releaseNotes", "defaultBrowserOffer", "telemetry"];
  return (windowId, capabilities = ["ArdiaShell.launchSteps", "ArdiaShell.completeLaunchStep"]) => ({
    bootstrap: { windowId, profileId: "default", capabilities },
    call: async () => "null",
    onEvent: () => () => {},
    invoke: async (method, { args }) => {
      if (method === "ArdiaShell.launchSteps") return [...steps];
      if (method === "ArdiaShell.completeLaunchStep") {
        if (args.length !== 1 || !STEPS.includes(args[0])) throw new Error("Unknown launch step");
        const added = !steps.has(args[0]);
        steps.add(args[0]);
        return added;
      }
      throw new Error(`unexpected ${method}`);
    },
  });
}

test("on Windows the telemetry session continues across a leader handoff and a reloaded leader, because the shell keeps the launch steps for the whole process", async () => {
  const windowOf = windowsProcess();
  const report = (error) => assert.fail(String(error));
  assert.equal(await continuesSession(windowOf("main"), report), false, "the first leader of a launch starts the session");
  assert.equal(await continuesSession(windowOf("w2"), report), true, "a window that takes over the lead continues it");
  assert.equal(await continuesSession(windowOf("main"), report), true, "a reloaded leader continues it");
  assert.equal(await continuesSession(windowsProcess()("main", []), report), false, "an engine without launch steps can't tell, so each lead starts one");
});

test("the Windows shell serves launch steps to every window from one process-wide record, refuses private windows and unknown steps, and knows exactly the Linux host's steps", () => {
  const read = (file) => readFileSync(join(REPO, "scripts/windows/engine/src/ardia/win/webui", file), "utf8");
  const calls = read("webui_host_calls.cc");
  for (const list of ["kWindowCapabilities[] = {", "kBrowserWindowCapabilities[] = {"]) {
    const body = calls.slice(calls.indexOf(list), calls.indexOf("};", calls.indexOf(list)));
    assert.match(body, /"ArdiaShell\.launchSteps",\s*"ArdiaShell\.completeLaunchStep",/, list);
  }
  assert.match(calls, /method == "ArdiaShell\.completeLaunchStep"\) \{\s*if \(private_window\(\)\)[\s\S]{0,300}WindowRegistry::Get\(\)\.launch_steps\(\)[\s\S]{0,700}ValidLaunchStep\(step\)[\s\S]{0,200}steps\.Complete\(step\)/);
  assert.match(read("webui_windows.h"), /webui_window::LaunchSteps launch_steps_;/);
  const stepsOf = (source, list) => {
    const from = source.indexOf(`${list}[] = {`);
    return [...source.slice(from, source.indexOf("};", from)).matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
  };
  const windowsSteps = stepsOf(read("webui_launch_steps.h"), "kLaunchSteps");
  const linuxSteps = stepsOf(readFileSync(join(REPO, "engine/ardiacore-linux/src/ardia/linux/ac_linux_launch_steps.h"), "utf8"), "kSteps");
  assert.ok(windowsSteps.includes("telemetry"), "the telemetry step the session handoff needs is a known step");
  assert.deepEqual(windowsSteps, linuxSteps, "Windows keeps the Linux host's launch steps, so a shared-UI step can't be known on one desktop host only");
  const view = read("webui_host_view.cc");
  const intercept = view.slice(view.indexOf("bool ShellHostView::InterceptSystemClose()"), view.indexOf("bool ShellHostView::CompanionsHoldTabs()"));
  assert.match(intercept, /RoutesSystemClose\(is_utility\(\), CompanionsHoldTabs\(\)\)/, "every browser window's WM_CLOSE goes through RequestClose, so an overlapping close is tracked");
});
