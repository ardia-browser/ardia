#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { session } from "../../../scripts/lib/instance.mjs";

const usage = `usage: tab-tools-check.mjs <Ardia.app> [scratch dir] [--keep]
Checks tabs.diagnostics and tabs.input end to end in one hidden instance launched with no DevTools port, so no
debugger can attach to any tab. A local page logs an error with a secret in it, a warning, an uncaught exception and an
unhandled rejection, and starts a fetch to a host that doesn't resolve and one that answers 404, all while it loads in
a background tab. Then, over the control socket only: tabs.diagnostics holds every one of them from the tab's creation,
redacted, with a watermark that returns only newer entries; tabs.input clicks a field, types text, presses a key,
clicks a button and turns the wheel in that background tab, and the page's own listeners (read back through
tabs.diagnostics) saw each event with isTrusted true while the page stayed hidden; a point outside the page is
refused; a move between down and up carries the held button, a key in between included, and a second down, an unmatched up or a click on a held button are refused; a NUL in text, key or code is refused; activation.log shows no activation, and none attempted across all the input sent; lsappinfo front is read and never names the instance. Use an app built with --bundle (its JS is inside).
The run uses a new folder in the scratch dir and removes only that folder unless --keep.`;
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const [appArg, scratchArg] = args.filter((a) => a !== "--keep");
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
const scratch = resolve(scratchArg ?? process.env.TMPDIR ?? "/tmp");
fs.mkdirSync(scratch, { recursive: true });
const work = fs.mkdtempSync(join(scratch, "ac-tab-tools-"));
const data = join(work, "d");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(join(data, "session.json"), JSON.stringify(session({ settings: { cliControl: true } })));
fs.writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail).slice(0, 900)})`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = `<!doctype html><title>tab tools</title>
<style>body{margin:0;height:3000px} #field{position:absolute;left:20px;top:20px;width:300px;height:40px;font-size:18px} #btn{position:absolute;left:20px;top:100px;width:120px;height:40px}</style>
<input id=field><button id=btn>Go</button>
<script>
const field = document.getElementById("field");
const report = (type, e) => console.info("EV " + type + " trusted=" + e.isTrusted + " vis=" + document.visibilityState + " value=" + field.value + (e.key ? " key=" + e.key : ""));
for (const type of ["mousedown", "mouseup", "click", "keydown", "keyup", "beforeinput", "input", "wheel"]) addEventListener(type, (e) => report(type, e), true);
field.addEventListener("focus", (e) => report("focus", e));
document.getElementById("btn").addEventListener("click", (e) => report("button", e));
addEventListener("mousemove", (e) => { if (e.buttons) console.info("EV drag buttons=" + e.buttons + " trusted=" + e.isTrusted); }, true);
addEventListener("scroll", () => console.info("EV scroll y=" + Math.round(scrollY)), { once: true });
console.error("load error token=supersecret123 Bearer abcdefghijkl");
console.warn("load warning vis=" + document.visibilityState);
setTimeout(() => { throw new Error("boom at load"); }, 0);
Promise.reject(new Error("rejected at load"));
fetch("http://ardia-tab-tools.invalid/x?key=abc").catch(() => {});
fetch("/missing?session=abc").catch(() => {});
</script>`;
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  res.writeHead(path === "/page" ? 200 : 404, { "content-type": "text/html" });
  res.end(path === "/page" ? page : "");
});
await new Promise((done) => server.listen({ port: 0, host: "127.0.0.1" }, done));
const origin = `http://127.0.0.1:${server.address().port}`;

let appPid = 0;
let frontWatch = null;
let cleaning = false;
const frontSeen = new Set();
const frontReads = { samples: 0, failures: 0 };
function instancePid() {
  try {
    const holders = execFileSync("lsof", ["-t", "--", join(data, "app.out.log")], { encoding: "utf8", timeout: 5000 }).split("\n").map(Number).filter((pid) => pid > 0);
    for (const pid of holders) {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
      if (command.startsWith(join(app, "Contents", "MacOS") + "/")) return pid;
    }
  } catch {}
  return 0;
}
function cleanup(code) {
  if (cleaning) return;
  cleaning = true;
  if (frontWatch) clearInterval(frontWatch);
  if (!appPid) appPid = instancePid();
  if (appPid) {
    try { process.kill(appPid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) {
      try { process.kill(appPid, 0); } catch { break; }
      execFileSync("sleep", ["0.1"]);
    }
    try { process.kill(appPid, "SIGKILL"); } catch {}
  }
  server.close();
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`INFO  kept ${work}`);
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));
setTimeout(() => {
  console.log("FAIL  the check ran past its 4 minute deadline");
  cleanup(2);
}, 240_000).unref();

function observeFront() {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8", timeout: 2000 }).trim();
    const info = execFileSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8", timeout: 2000 });
    const pid = Number(/\bpid\s*=\s*(\d+)/.exec(info)?.[1] ?? 0);
    if (pid > 0) {
      frontSeen.add(pid);
      frontReads.samples++;
    } else {
      frontReads.failures++;
    }
  } catch {
    frontReads.failures++;
  }
}

function controlSocket() {
  const socket = net.createConnection(join(data, "ArdiaControl.sock"));
  let buffer = "";
  let nextId = 0;
  const waiting = new Map();
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      const pending = waiting.get(msg.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      waiting.delete(msg.id);
      pending.resolve(msg);
    }
  });
  const fail = (why) => {
    for (const { resolve: done, timer } of waiting.values()) {
      clearTimeout(timer);
      done({ error: { code: "socket", message: why } });
    }
    waiting.clear();
  };
  socket.on("error", (error) => fail(error.message));
  socket.on("close", () => fail("closed"));
  const call = (method, params = {}) =>
    new Promise((done) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        done({ error: { code: "timeout", message: `no reply to ${method} in 15 s` } });
      }, 15_000);
      waiting.set(id, { resolve: done, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  return { call, close: () => socket.destroy() };
}

execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, "--stdout", join(data, "app.out.log"), "--stderr", join(data, "app.out.log"), app]);
let control = null;
for (let i = 0; i < 400 && !control; i++) {
  if (!appPid) appPid = instancePid();
  try { control = JSON.parse(fs.readFileSync(join(data, "Chromium", "ArdiaControl.json"), "utf8")); } catch { await sleep(200); }
}
if (!control) {
  if (!appPid) appPid = instancePid();
  console.log(`FAIL  control never started${appPid ? "" : ", and the instance's pid was never found to stop it"}`);
  cleanup(1);
}
const foundPid = appPid;
appPid = control.pid;
check("the instance found by its log before control started is the one control names", foundPid === control.pid, { foundPid, control: control.pid });
frontWatch = setInterval(observeFront, 150);
for (let i = 0; i < 100 && !fs.existsSync(join(data, "ArdiaControl.sock")); i++) await sleep(100);

try {
  check("the instance has no DevTools port to attach a debugger through", !fs.existsSync(join(data, "Chromium", "DevToolsActivePort")));
  const ctl = controlSocket();
  const hello = await ctl.call("hello", { client: "tab-tools-check", protocol: 4 });
  check("hello", !hello.error, hello);
  const methods = (await ctl.call("methods")).result ?? [];
  check("methods lists tabs.diagnostics and tabs.input", ["tabs.diagnostics", "tabs.input"].every((m) => methods.some((x) => x.name === m)));

  const opened = await ctl.call("apply", { ops: [{ op: "open", urls: [`${origin}/page`] }] });
  check("the page opens in a background tab", !opened.error, opened);
  let tab = null;
  for (let i = 0; i < 50 && !tab; i++) {
    const listed = (await ctl.call("tabs.list")).result ?? [];
    tab = listed.find((t) => (t.url ?? "").startsWith(`${origin}/page`)) ?? null;
    if (!tab) await sleep(100);
  }
  check("tabs.list has the page's tab, not active", tab && tab.active === false, tab);

  let read = null;
  const wantLoad = (r) => r?.console?.some((e) => e.kind === "rejection") && r?.console?.some((e) => e.kind === "exception") && r?.network?.some((e) => e.error === "ERR_NAME_NOT_RESOLVED") && r?.network?.some((e) => e.status === 404);
  for (let i = 0; i < 60 && !wantLoad(read); i++) {
    read = (await ctl.call("tabs.diagnostics", { tab: tab.id })).result;
    if (!wantLoad(read)) await sleep(250);
  }
  const messages = (read?.console ?? []).map((e) => `${e.level}/${e.kind}: ${e.message}`);
  check("console from the tab's creation: the error, the warning, the uncaught exception and the unhandled rejection", read && messages.some((m) => m.startsWith("error/console: load error")) && messages.some((m) => m.startsWith("warning/console: load warning")) && messages.some((m) => m.startsWith("error/exception: Uncaught Error: boom at load")) && messages.some((m) => m.startsWith("error/rejection: Uncaught (in promise) Error: rejected at load")), messages);
  check("secrets in a message are redacted", messages.some((m) => m.includes("token=[redacted]") && m.includes("Bearer [redacted]")) && !messages.some((m) => m.includes("supersecret123") || m.includes("abcdefghijkl")), messages);
  const failedFetch = read?.network?.find((e) => e.error === "ERR_NAME_NOT_RESOLVED");
  const missing = read?.network?.find((e) => e.status === 404);
  check("the fetch to a host that doesn't resolve is recorded as failed, its query gone", failedFetch && failedFetch.failed === true && failedFetch.url === "http://ardia-tab-tools.invalid/x" && failedFetch.type === "fetch", failedFetch);
  check("the 404 is recorded as failed with its status and no query", missing && missing.failed === true && missing.url === `${origin}/missing` && missing.method === "GET", missing);
  const documentLoad = read?.network?.find((e) => e.type === "document");
  check("the page's own load is recorded with its status and time", documentLoad && documentLoad.status === 200 && typeof documentLoad.durationMs === "number", documentLoad);
  check("seqs share one order and nextSeq is past them all", read && [...read.console, ...read.network].every((e) => e.seq < read.nextSeq), read && { nextSeq: read.nextSeq });
  check("the page loaded hidden", messages.some((m) => m.includes("load warning vis=hidden")), messages);
  const empty = (await ctl.call("tabs.diagnostics", { tab: tab.id, since: read.nextSeq })).result;
  check("a read from the watermark returns nothing new", empty && empty.console.length === 0 && empty.network.length === 0 && empty.dropped === 0, empty);
  const errorsOnly = (await ctl.call("tabs.diagnostics", { tab: tab.id, onlyErrors: true, kind: "network" })).result;
  check("onlyErrors with kind network keeps only failed requests", errorsOnly && errorsOnly.console.length === 0 && errorsOnly.network.length >= 2 && errorsOnly.network.every((e) => e.failed), errorsOnly?.network);

  const mark = read.nextSeq;
  const steps = [
    ["click", { action: "click", x: 100, y: 40 }],
    ["text", { action: "text", text: "hello" }],
    ["key", { action: "key", key: "!", code: "Digit1", modifiers: ["shift"] }],
    ["button", { action: "click", x: 60, y: 120 }],
    ["wheel", { action: "wheel", x: 200, y: 300, deltaY: 400 }],
    ["down", { action: "down", x: 400, y: 200 }],
    ["key while held", { action: "key", key: "Shift", code: "ShiftLeft" }],
    ["move", { action: "move", x: 450, y: 220 }],
    ["up", { action: "up", x: 450, y: 220 }],
  ];
  const activationLines = () => {
    try {
      return fs.readFileSync(join(data, "activation.log"), "utf8").split("\n");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const activationBefore = activationLines().length;
  for (const [name, params] of steps) {
    const reply = await ctl.call("tabs.input", { tab: tab.id, ...params });
    if (name === "text") check("tabs.input text is sent", reply.result?.sent === true && reply.result?.acked === false, reply);
    else check(`tabs.input ${name} is taken and acked by the renderer`, reply.result?.acked === true, reply);
  }
  for (const [field, params] of [["text", { action: "text", text: "a\u0000b" }], ["key", { action: "key", key: "a\u0000" }], ["code", { action: "key", key: "a", code: "KeyA\u0000" }]]) {
    const nul = await ctl.call("tabs.input", { tab: tab.id, ...params });
    check(`a NUL in ${field} is refused`, nul.error?.code === "bad_request", nul);
  }
  const unmatched = await ctl.call("tabs.input", { tab: tab.id, action: "up", x: 10, y: 10 });
  check("an up for a button that isn't down is refused", unmatched.error?.code === "bad_request", unmatched);
  await ctl.call("tabs.input", { tab: tab.id, action: "down", x: 400, y: 200 });
  const twice = await ctl.call("tabs.input", { tab: tab.id, action: "down", x: 400, y: 200 });
  check("a second down for a held button is refused", twice.error?.code === "bad_request", twice);
  const heldClick = await ctl.call("tabs.input", { tab: tab.id, action: "click", x: 400, y: 200 });
  check("a click on a held button is refused", heldClick.error?.code === "bad_request", heldClick);
  await ctl.call("tabs.input", { tab: tab.id, action: "up", x: 400, y: 200 });
  const outside = await ctl.call("tabs.input", { tab: tab.id, action: "click", x: 99999, y: 10 });
  check("a point outside the page is refused", outside.error?.code === "bad_request", outside);
  const right = await ctl.call("tabs.input", { tab: tab.id, action: "click", x: 60, y: 120, button: "right" });
  check("a right click, which would open Ardia's own menu, is refused", right.error?.code === "bad_request", right);
  let events = [];
  for (let i = 0; i < 40; i++) {
    const after = (await ctl.call("tabs.diagnostics", { tab: tab.id, since: mark, kind: "console" })).result;
    events = (after?.console ?? []).map((e) => e.message).filter((m) => m.startsWith("EV "));
    if (events.some((m) => m.startsWith("EV scroll")) && events.some((m) => m.startsWith("EV button")) && events.some((m) => m.startsWith("EV drag"))) break;
    await sleep(150);
  }
  const has = (prefix) => events.find((m) => m.startsWith(prefix));
  check("the click reached the field as trusted mouse events", ["EV mousedown trusted=true", "EV mouseup trusted=true", "EV click trusted=true", "EV focus trusted=true"].every(has), events);
  check("the text was inserted with trusted beforeinput and input", has("EV beforeinput trusted=true") && events.some((m) => m.startsWith("EV input trusted=true") && m.includes("value=hello")), events);
  check("the key press typed a trusted ! after it", events.some((m) => m.startsWith("EV keydown trusted=true") && m.includes("key=!")) && events.some((m) => m.startsWith("EV input trusted=true") && m.includes("value=hello!")), events);
  check("the button got a trusted click", events.some((m) => m.startsWith("EV button trusted=true")), events);
  check("the wheel was trusted and scrolled the page", has("EV wheel trusted=true") && events.some((m) => /^EV scroll y=[1-9]/.test(m)), events);
  check("a move between down and up carries the held button, a key pressed in between included", events.some((m) => m === "EV drag buttons=1 trusted=true"), events);
  check("every event arrived while the page stayed hidden", events.filter((m) => m.includes("vis=")).every((m) => m.includes("vis=hidden")), events);
  await sleep(250);
  const activationDuring = activationLines().slice(Math.max(0, activationBefore - 1)).filter((line) => /^\S+ \S+ \S+ (became active|blocked)/.test(line));
  check("no activation was attempted or made across all the input sent", activationDuring.length === 0, activationDuring);
  const tabAfter = (await ctl.call("tabs.get", { tab: tab.id })).result;
  check("the tab is still in the background", tabAfter?.active === false, tabAfter);

  ctl.close();
  observeFront();
  check("lsappinfo front was read and never named the instance", frontReads.samples > 0 && !frontSeen.has(appPid), { seen: [...frontSeen], ...frontReads });
  const activations = activationLines().join("\n");
  const activated = activationLines().filter((line) => /became active/.test(line));
  check("activation.log shows the app never became active", activated.length === 0, activated);
  console.log(`INFO  ${frontReads.samples} front samples (${frontReads.failures} unreadable), ${frontSeen.size} distinct front apps, activation.log has ${activations.split("\n").filter(Boolean).length} lines`);
} catch (error) {
  check(error.message, false);
}
console.log(failures ? `${failures} failed` : "all passed");
cleanup(failures ? 1 : 0);
