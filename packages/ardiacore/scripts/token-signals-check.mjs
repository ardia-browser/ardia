#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { session } from "../../../scripts/lib/instance.mjs";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const usage = `usage: token-signals-check.mjs <Ardia.app> [metro host:port] [scratch dir]
Runs Ardia's engine-answered DevTools methods over the real token connection (no DevTools port) in one hidden
instance, with a local page that logs a warning, an error and an uncaught exception as it loads and holds a cross-site
iframe. Checks: Ardia.consoleDelta holds the load-time entries before any session attached, a watermark returns only
newer entries, a stale generation starts over with reset; Ardia.hitTest finds a button's own click listener, a covered
element's overlay, body-only delegation, a container's pointerdown one level up, a same-origin iframe's node as another frame and the hit frame's Document as holding the hit, and reports a cross-site iframe as a
remote frame instead of a blocker; Ardia.focusedFrameOrigin reads the main frame and then the iframe's origin with a
document id; every method is refused on the browser session, on an iframe's session and with a targetId; bad
parameters are refused, and every value of the shared hostile-input corpus, as each parameter and as a parameter name,
is refused by the engine's guard (a request it can't parse, such as one with a lone surrogate escape, gets the framing
refusal under id 0) or accepted only where it is a valid value; hit tests still in flight when their connection closes are cancelled and free their slots, and
at most 4 run at once. Then tabs.hold {untilDisconnect, live} from a separate process makes a background tab visible
to its page, and SIGKILL of that process hides it again. A Debug build needs its Metro as the second argument. The run uses a new folder inside the scratch dir and removes
only that folder.`;
const [appArg, metroArg, scratchArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
const scratch = resolve(scratchArg ?? process.env.TMPDIR ?? "/tmp");
fs.mkdirSync(scratch, { recursive: true });
const work = fs.mkdtempSync(join(scratch, "ac-token-signals-"));
const data = join(work, "d");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(join(data, "session.json"), JSON.stringify(session({ settings: { cliControl: true } })));
fs.writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail).slice(0, 600)})`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port = 0;
const pages = {
  "/page": () => `<!doctype html><title>signals</title>
<style>body{margin:0;height:900px} #btn{position:absolute;left:20px;top:20px;width:120px;height:40px} #covered{position:absolute;left:20px;top:100px;width:120px;height:40px} #cover{position:absolute;left:10px;top:90px;width:200px;height:60px;background:rgba(0,0,0,.1)} #plain{position:absolute;left:20px;top:200px;width:120px;height:40px} #wrap{position:absolute;left:300px;top:20px;width:200px;height:80px} #inner{display:inline-block;width:100px;height:30px} iframe{position:absolute;left:20px;top:300px;width:300px;height:100px;border:0} #same{left:360px;top:300px;width:200px;height:100px} #wide{position:absolute;left:360px;top:200px;width:120px;height:30px;display:block}</style>
<button id=btn>Go</button><div id=covered>covered</div><div id=cover></div><div id=plain>plain</div><div id=wrap><span id=inner>inner</span></div>
<iframe id=frame src="http://localhost:${port}/frame"></iframe>
<iframe id=same srcdoc="<button id=inside>inside</button>"></iframe>
<x--${"\u00e9".repeat(40)} id=wide>wide</x--${"\u00e9".repeat(40)}>
<script>
console.warn("warn at load");
console.error("error at load");
console.log("log is not kept");
document.getElementById("btn").addEventListener("click", () => {});
document.getElementById("covered").addEventListener("click", () => {});
document.getElementById("wrap").addEventListener("pointerdown", () => {});
document.body.addEventListener("click", () => {});
setTimeout(() => { throw new Error("boom at load"); }, 0);
</script>`,
  "/frame": () => `<!doctype html><style>body{margin:0}input{width:280px;height:80px}</style><input id=pw type=password>`,
  "/vis": () => `<!doctype html><title>vis</title><script>
console.warn("vis-initial:" + document.visibilityState);
document.addEventListener("visibilitychange", () => console.warn("vis:" + document.visibilityState));
</script>`,
};
const server = http.createServer((req, res) => {
  const page = pages[new URL(req.url, "http://x").pathname];
  res.writeHead(page ? 200 : 404, { "content-type": "text/html" });
  res.end(page ? page() : "");
});
await new Promise((done) => server.listen({ port: 0, host: "::", ipv6Only: false }, done));
port = server.address().port;
const mainOrigin = `http://127.0.0.1:${port}`;

let appPid = 0;
const children = [];
const sockets = [];
function cleanup(code) {
  for (const child of children) try { child.kill("SIGKILL"); } catch {}
  for (const socket of sockets) try { socket.close(); } catch {}
  if (appPid) {
    try { process.kill(appPid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) {
      try { process.kill(appPid, 0); } catch { break; }
      execFileSync("sleep", ["0.1"]);
    }
    try { process.kill(appPid, "SIGKILL"); } catch {}
  }
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.log("FAIL  the check ran past its 5 minute deadline");
  cleanup(2);
}, 300_000).unref();

execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, ...(metroArg ? ["--env", `ARDIA_INSTANCE=jsLocation=${metroArg}`] : []), "--stdout", join(data, "app.out.log"), "--stderr", join(data, "app.out.log"), app]);
let control = null;
for (let i = 0; i < 400 && !control; i++) {
  try { control = JSON.parse(fs.readFileSync(join(data, "Chromium", "ArdiaControl.json"), "utf8")); } catch { await sleep(200); }
}
if (!control) {
  console.log("FAIL  the token server never started");
  cleanup(1);
}
appPid = control.pid;

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${control.port}${control.browser}?token=${control.token}`);
  sockets.push(ws);
  const opened = await new Promise((done) => {
    ws.onopen = () => done(true);
    ws.onerror = (e) => done(e?.message ?? "error");
    ws.onclose = (e) => done(`closed ${e.code}`);
    setTimeout(() => done("timeout"), 15_000);
  });
  if (opened !== true) throw new Error(`the token WebSocket didn't open: ${opened}`);
  let nextId = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id === undefined) return;
    if (msg.id === 0 && msg.error?.code === -32700 && waiting.size === 1) {
      const [only] = waiting.values();
      waiting.clear();
      only({ ...msg, unparsed: true });
      return;
    }
    const key = `${msg.sessionId ?? ""}:${msg.id}`;
    waiting.get(key)?.(msg);
    waiting.delete(key);
  };
  const send = (method, params = {}, sessionId) => new Promise((done) => {
    const id = ++nextId;
    const key = `${sessionId ?? ""}:${id}`;
    const timer = setTimeout(() => { waiting.delete(key); done({ timedOut: true, error: { message: `no reply to ${method} in 15 s` } }); }, 15_000);
    waiting.set(key, (msg) => { clearTimeout(timer); done(msg); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const ok = async (method, params, sessionId) => {
    const reply = await send(method, params, sessionId);
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  return { ws, send, ok };
}

function controlSocket() {
  const socket = net.createConnection(join(data, "ArdiaControl.sock"));
  let buffer = "";
  let nextId = 0;
  let broken = null;
  const waiting = new Map();
  const failAll = (why) => {
    broken = broken ?? why;
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(new Error(`the control socket ${broken}`));
    }
    waiting.clear();
  };
  socket.on("error", (error) => failAll(`failed: ${error.code ?? error.message}`));
  socket.on("close", () => failAll("closed"));
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
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (broken) return reject(new Error(`the control socket ${broken}`));
    const id = ++nextId;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no reply to ${method} on the control socket in 15 s`));
    }, 15_000);
    waiting.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { call, close: () => socket.destroy() };
}

try {
  const { send, ok } = await connect();
  const { targetId } = await ok("Target.createTarget", { url: `${mainOrigin}/page` });
  await sleep(3000);
  const { sessionId } = await ok("Target.attachToTarget", { targetId, flatten: true });
  const ring = await ok("Ardia.consoleDelta", {}, sessionId);
  const texts = ring.entries.map((e) => `${e.level}:${e.exception ? "x" : ""}:${e.text}`);
  check("the ring holds the load-time warning, error and uncaught exception from before any session attached",
    texts.includes("warning::warn at load") && texts.includes("error::error at load") && texts.some((t) => t.startsWith("error:x:Uncaught Error: boom at load")) && !texts.some((t) => t.includes("log is not kept")) && ring.reset === false && ring.generation > 0, { texts, ring });
  await ok("Runtime.evaluate", { expression: 'console.error("after attach"); 1' }, sessionId);
  await sleep(300);
  const delta = await ok("Ardia.consoleDelta", { after: ring.next, generation: ring.generation }, sessionId);
  check("a watermark with its generation returns only what came after", delta.entries.length === 1 && delta.entries[0].text === "after attach" && delta.reset === false, delta);
  const stale = await ok("Ardia.consoleDelta", { after: delta.next, generation: ring.generation + 1000 }, sessionId);
  check("a stale generation starts the read over and says so", stale.reset === true && stale.entries.length === texts.length + 1, stale);

  const refused = await Promise.all([
    send("Ardia.consoleDelta", {}),
    send("Ardia.focusedFrameOrigin", {}),
    send("Ardia.hitTest", { x: 1, y: 1 }),
    send("Ardia.consoleDelta", { targetId }, sessionId),
    send("Ardia.consoleDelta", { targetId }),
  ]);
  check("every method is refused on the browser session and with a targetId", refused.every((r) => !!r.error), refused.map((r) => r.error?.message));

  const { targetInfos } = await ok("Target.getTargets", {});
  const frame = targetInfos.find((t) => t.type === "iframe" && t.url.includes("/frame"));
  check("the cross-site iframe is its own target", !!frame, targetInfos.map((t) => `${t.type} ${t.url}`));
  const frameSession = frame ? (await ok("Target.attachToTarget", { targetId: frame.targetId, flatten: true })).sessionId : null;
  if (frameSession) {
    const onFrame = await Promise.all(["Ardia.consoleDelta", "Ardia.focusedFrameOrigin"].map((method) => send(method, {}, frameSession)));
    check("an iframe's session can't read the tab's signals", onFrame.every((r) => !!r.error), onFrame.map((r) => r.error?.message));
  }

  const bad = await Promise.all([
    send("Ardia.consoleDelta", { after: -1 }, sessionId),
    send("Ardia.consoleDelta", { generation: "1" }, sessionId),
    send("Ardia.consoleDelta", { nope: 1 }, sessionId),
    ...[{ x: "1", y: 2 }, { x: 1 }, { x: 1, y: 2, backendNodeId: -4 }, { x: 1e9, y: 2 }, { x: 1, y: 2, extra: true }].map((p) => send("Ardia.hitTest", p, sessionId)),
    ...["https://a.example/path", "javascript:alert(1)", "", "x".repeat(3000), 5].map((expectedOrigin) => send("Ardia.focusedFrameOrigin", { expectedOrigin }, sessionId)),
  ]);
  check("bad parameters are refused", bad.every((r) => !!r.error), bad.map((r) => r.error?.message));

  const wholeIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const bareOrigin = (value) => {
    if (typeof value !== "string" || !value || value.length > 2048) return false;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  };
  const corpusCases = [];
  for (const { id, value } of HOSTILE_VALUES) {
    if (value === undefined) continue;
    corpusCases.push(
      [`consoleDelta after ${id}`, "Ardia.consoleDelta", { after: value }, wholeIn(value, 0, Number.MAX_SAFE_INTEGER), /^ardia: after must be a whole number from a previous next$/],
      [`consoleDelta generation ${id}`, "Ardia.consoleDelta", { generation: value }, wholeIn(value, 0, Number.MAX_SAFE_INTEGER), /^ardia: generation must be the generation of a previous reply$/],
      [`consoleDelta limit ${id}`, "Ardia.consoleDelta", { limit: value }, wholeIn(value, 1, 200), /^ardia: limit must be a whole number from 1 to 200$/],
      [`focusedFrameOrigin expectedOrigin ${id}`, "Ardia.focusedFrameOrigin", { expectedOrigin: value }, bareOrigin(value), /^ardia: expectedOrigin must be an http or https origin such as https:\/\/example\.com$/],
      [`hitTest x ${id}`, "Ardia.hitTest", { x: value, y: 10 }, typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6, /^ardia: x and y must be numbers in CSS pixels from the viewport's top left$/],
      [`hitTest y ${id}`, "Ardia.hitTest", { x: 10, y: value }, typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6, /^ardia: x and y must be numbers in CSS pixels from the viewport's top left$/],
      [`hitTest backendNodeId ${id}`, "Ardia.hitTest", { x: 10, y: 10, backendNodeId: value }, wholeIn(value, 1, 2 ** 31 - 1), /^ardia: backendNodeId must be a positive integer$/],
    );
    if (typeof value === "string") corpusCases.push([`consoleDelta param name ${id}`, "Ardia.consoleDelta", { [value]: 1 }, false, /^ardia: unknown parameter /s]);
  }
  const corpusBreaches = [];
  const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const holdsLoneSurrogate = (params) => Object.entries(params).some(([key, value]) => loneSurrogate.test(key) || (typeof value === "string" && loneSurrogate.test(value)));
  for (const [name, method, params, mayAccept, guard] of corpusCases) {
    const reply = await send(method, params, sessionId);
    const message = reply.error?.message ?? "";
    if (reply.timedOut) corpusBreaches.push(`${name}: no reply`);
    else if (reply.unparsed) {
      if (reply.error.code !== -32700 || !holdsLoneSurrogate(params)) corpusBreaches.push(`${name}: framing refusal for a parseable request (${message})`);
    } else if (reply.error && !mayAccept && (reply.error.code !== -32000 || !guard.test(message))) corpusBreaches.push(`${name}: not the parameter guard's refusal (${reply.error.code} ${message})`);
    else if (reply.error && mayAccept && !/^ardia: /.test(message)) corpusBreaches.push(`${name}: an error from outside the engine (${message})`);
    else if (!reply.error && !mayAccept) corpusBreaches.push(`${name}: accepted`);
    else if (!reply.error && !reply.result) corpusBreaches.push(`${name}: no result`);
  }
  const alive = await send("Ardia.consoleDelta", { limit: 1 }, sessionId);
  check(`the shared hostile-input corpus (${corpusCases.length} requests) is refused wherever it isn't a valid value, and the browser keeps answering`, corpusBreaches.length === 0 && !!alive.result, corpusBreaches);

  const rects = JSON.parse((await ok("Runtime.evaluate", { expression: `JSON.stringify(Object.fromEntries(["btn","covered","plain","inner","frame","wide"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { x: r.x + r.width / 2, y: r.y + r.height / 2 }]; })))`, returnByValue: true }, sessionId)).result.value);
  let { root } = await ok("DOM.getDocument", { depth: 0 }, sessionId);
  const backend = async (selector) => {
    const { nodeId } = await ok("DOM.querySelector", { nodeId: root.nodeId, selector }, sessionId);
    return (await ok("DOM.describeNode", { nodeId }, sessionId)).node.backendNodeId;
  };
  const btn = await ok("Ardia.hitTest", rects.btn, sessionId);
  check("a button with its own click listener", btn.hit?.nodeName === "BUTTON" && btn.hasClickListener === true && btn.listener?.depth === 0 && btn.listener?.types?.includes("click"), btn);
  const coveredId = await backend("#covered");
  const covered = await ok("Ardia.hitTest", { ...rects.covered, backendNodeId: coveredId }, sessionId);
  check("a covered element is occluded by the overlay", covered.occluded === true && covered.blockedBy?.nodeName === "DIV" && covered.hit?.backendNodeId !== coveredId && covered.hasClickListener === false && covered.delegated === true, covered);
  const self = await ok("Ardia.hitTest", { ...rects.btn, backendNodeId: await backend("#btn") }, sessionId);
  check("an element under its own point isn't occluded", self.occluded === false, self);
  const plain = await ok("Ardia.hitTest", rects.plain, sessionId);
  check("a plain div only has body's delegated listener", plain.hasClickListener === false && plain.delegated === true && plain.delegatedTo?.nodeName === "BODY", plain);
  const inner = await ok("Ardia.hitTest", rects.inner, sessionId);
  check("a span inside a pointerdown container finds it one level up", inner.hit?.nodeName === "SPAN" && inner.listener?.nodeName === "DIV" && inner.listener?.depth === 1 && inner.listener?.types?.includes("pointerdown"), inner);
  const { root: deep } = await ok("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
  root = deep;
  const sameFrameDoc = (function find(node) {
    if (node.attributes?.includes("same") && node.contentDocument) return node.contentDocument;
    for (const child of node.children ?? []) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  })(deep);
  const { nodeId: insideId } = await ok("DOM.querySelector", { nodeId: sameFrameDoc.nodeId, selector: "#inside" }, sessionId);
  const insideBackend = (await ok("DOM.describeNode", { nodeId: insideId }, sessionId)).node.backendNodeId;
  const sameOrigin = await ok("Ardia.hitTest", { ...rects.btn, backendNodeId: insideBackend }, sessionId);
  check("a node of a same-origin iframe counts as another frame, not as covered inside the hit frame", sameOrigin.occluded === true && sameOrigin.targetInOtherFrame === true, sameOrigin);
  const asDocument = await ok("Ardia.hitTest", { ...rects.btn, backendNodeId: root.backendNodeId }, sessionId);
  check("the hit frame's own Document as the target holds the hit node and isn't another frame", asDocument.occluded === false && asDocument.targetInOtherFrame === undefined, asDocument);
  const wide = await send("Ardia.hitTest", rects.wide, sessionId);
  const wideName = wide.result?.hit?.nodeName ?? "";
  check("a non-ASCII element name longer than 64 bytes comes back cut at a character boundary", !!wide.result && new TextEncoder().encode(wideName).length <= 64 && wideName.startsWith("X--") && !wideName.includes("\ufffd"), wide);
  const intoFrame = await ok("Ardia.hitTest", { ...rects.frame, backendNodeId: await backend("#btn") }, sessionId);
  check("a point over a cross-site iframe says remote frame, not a blocker", intoFrame.unsupported === "remote-frame" && !!intoFrame.remoteFrame?.frameId && intoFrame.blockedBy === undefined && intoFrame.occluded === undefined, intoFrame);

  const doomed = await connect();
  const { sessionId: doomedSession } = await doomed.ok("Target.attachToTarget", { targetId, flatten: true });
  for (let i = 0; i < 4; i++) doomed.ws.send(JSON.stringify({ id: 1000 + i, method: "Ardia.hitTest", params: rects.inner, sessionId: doomedSession }));
  doomed.ws.close();
  await sleep(500);
  const burst = await Promise.all(Array.from({ length: 6 }, () => send("Ardia.hitTest", rects.inner, sessionId)));
  const answered = burst.filter((r) => r.result?.hit).length;
  const capped = burst.filter((r) => /too many hit tests/.test(r.error?.message ?? "")).length;
  check("hit tests in flight when their connection closed freed their slots, and exactly 4 of 6 sent at once run", answered === 4 && capped === 2, burst.map((r) => r.error?.message ?? "ok"));

  await ok("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  await ok("Runtime.evaluate", { expression: 'document.getElementById("btn").focus(); 1' }, sessionId);
  await sleep(200);
  const mainFocus = await ok("Ardia.focusedFrameOrigin", { expectedOrigin: mainOrigin }, sessionId);
  check("the main frame's origin comes from the browser and matches", mainFocus.focused && mainFocus.origin === mainOrigin && mainFocus.mainFrame === true && mainFocus.matches === true && typeof mainFocus.documentId === "string", mainFocus);
  const again = await ok("Ardia.focusedFrameOrigin", {}, sessionId);
  check("the same document keeps its document id", again.documentId === mainFocus.documentId, again);
  if (frameSession) {
    await ok("Emulation.setFocusEmulationEnabled", { enabled: true }, frameSession);
    await ok("Runtime.evaluate", { expression: 'document.getElementById("pw").focus(); 1' }, frameSession);
    await sleep(300);
    const frameFocus = await ok("Ardia.focusedFrameOrigin", { expectedOrigin: mainOrigin }, sessionId);
    check("with the cross-site iframe's password field focused, the origin is the iframe's", frameFocus.focused && frameFocus.origin === `http://localhost:${port}` && frameFocus.mainFrame === false && frameFocus.matches === false && frameFocus.documentId !== mainFocus.documentId, frameFocus);
  }

  const ctl = controlSocket();
  await ctl.call("hello", { client: "token-signals-check", protocol: 4 });
  await ok("Target.createTarget", { url: `${mainOrigin}/vis`, background: true });
  await sleep(2500);
  const listed = await ctl.call("tabs.list", {});
  const visTab = listed.result?.find((t) => (t.url ?? "").endsWith("/vis"));
  const visRead = async (after) => (await ctl.call("tabs.consoleDelta", { tab: visTab.id, after })).result;
  const visRing = await visRead(0);
  check("a background tab starts hidden", visRing?.entries?.some((e) => e.text === "vis-initial:hidden"), visRing);
  const holder = spawn(process.execPath, ["-e", `
    const s = require("node:net").createConnection(${JSON.stringify(join(data, "ArdiaControl.sock"))});
    let buffer = "";
    s.on("data", (d) => {
      buffer += d;
      for (let i; (i = buffer.indexOf("\\n")) >= 0; ) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (msg.id === 2) console.log(JSON.stringify(msg));
      }
    });
    s.write(JSON.stringify({ id: 1, method: "hello", params: { client: "holder", protocol: 4 } }) + "\\n");
    s.write(JSON.stringify({ id: 2, method: "tabs.hold", params: { session: "watchdog", tabs: [${JSON.stringify(visTab.id)}], untilDisconnect: true, live: true } }) + "\\n");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(holder);
  const holdReply = await new Promise((done) => {
    let out = "";
    const timer = setTimeout(() => done(null), 20_000);
    holder.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) { clearTimeout(timer); done(JSON.parse(out.split("\n")[0])); }
    });
  });
  check("tabs.hold untilDisconnect live holds the tab and the engine keeps it", holdReply?.result?.untilDisconnect === true && holdReply?.result?.live === true && holdReply?.result?.seconds === null && holdReply?.result?.engineKeeps === true, holdReply);
  await sleep(1500);
  const shown = await visRead(visRing.next);
  check("a live hold makes the background tab visible to its page without showing it", shown?.entries?.some((e) => e.text === "vis:visible"), shown);
  const killedAt = Date.now();
  holder.kill("SIGKILL");
  let hiddenAfter = null;
  for (let i = 0; i < 50 && hiddenAfter === null; i++) {
    await sleep(100);
    const later = await visRead(shown.next);
    if (later?.entries?.some((e) => e.text === "vis:hidden")) hiddenAfter = Date.now() - killedAt;
  }
  check("SIGKILL of the holding process ends the hold and the tab is hidden again", hiddenAfter !== null);
  console.log(`INFO  hidden again within ${hiddenAfter} ms of SIGKILL (read every 100 ms)`);
  ctl.close();
} catch (error) {
  check(error.message, false);
}
console.log(failures ? `${failures} failed` : "all passed");
cleanup(failures ? 1 : 0);
