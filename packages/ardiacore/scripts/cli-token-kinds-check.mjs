#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { X509Certificate, createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchVariables, session, sleep } from "../../../scripts/lib/instance.mjs";

const usage = `usage: cli-token-kinds-check.mjs <Ardia.app>
Checks the two kinds of token connection in one hidden instance with two windows, over the real token server (no
DevTools port). It needs a test build: it launches with the test flags privatePasteboard and pluginInputHold and aborts
before its first step unless the engine reports both. A Developer ID build ignores test flags, so there it stops at
that gate (the expected result on a signed build). pluginInputHold holds a plugin's mouse deliveries for 2 s and its
out-of-scope detaches for 5 s, so a delivery admitted before its tab leaves lands after the tab is back, every run,
and cliControlStatus's pluginDeliveriesRefusedDeparted proves the gate refused it. It needs openssl: a local HTTPS
server with a throwaway certificate (trusted by SPKI through chromiumSwitches) is the positive navigate case. A plugin\nclicks only with Ardia.dispatchClick, and an owner drag still drops.
The ardia command's token (kind cli) gets every method and target, including Browser.setDownloadBehavior, a chrome://
page and the browser target. A plugin credential minted for window 1 (engine.cliPluginCredential, kind plugin) sees and
attaches only window 1's web pages, is refused a chrome:// attach, Browser.setDownloadBehavior, DOM.setFileInputFiles,
cookies, Target.createTarget and window 2's page, isn't written to ArdiaControl.json and can't read /ardia/active;
revoking it closes its socket and a new connection with it is refused. A plugin's attach takes no visibility hold: its
background tab reports visibilityState hidden and refuses its wheels (page hidden) until the lease's hold
(engine.cliPluginCredential {id, tabId, visible}) turns on; with it the tab reports visible, still in the background, and
a wheel scrolls it; turning it off hides the tab again; a second on or off changes nothing; a hold on another window's
tab, on a tab it has no session with, or for an unknown credential is refused; two back-to-back wheels give an
acknowledged wheel and then busy (one outstanding wheel per credential and tab); it drops when the last session on the
tab detaches, at once when the tab leaves the window (a hold after it comes back is refused while the old session
is still detaching), and on revoke; and the owner token still makes a tab visible when it attaches. A plugin gets exactly its allowlist: the
plain-data DOM and accessibility reads work; DOM.focus, DOM.scrollIntoViewIfNeeded, Page.captureScreenshot and
Emulation.setFocusEmulationEnabled are refused (Ardia.dispatchClick focuses a field, a wheel scrolls); its moves and
wheels, keys and text never focus the page (only Ardia.dispatchClick does), and clicks, moves and wheels go
only to the page target's own session (a wheel reports submitted); input held past an in-scope navigation is refused; and every
Runtime method, DOM.resolveNode, DOM search, Page.createIsolatedWorld and any Runtime object or context id are refused,
as are Page.navigate's referrer, referrerPolicy, transitionType and frameId, every scheme but http, https and
about:blank, and a script on reload; no Network, console or Runtime event reaches it; a frame of another tab is out of
its reach; it accepts and cancels a dialog; keys and insertText type; its Input.dispatchMouseEvent is refused for
presses, releases and moves with a button, and Ardia.dispatchClick clicks, double-clicks a word and starts no drag. When its tab moves to another window (or out and straight
back), a command in flight answers tab_out_of_scope, a late reply never arrives, the session is detached, mouse and
wheel input it queued before the move never lands even though the tab is back, and a fresh attach to the returned tab
takes input again. Backend node ids from another tab in the same renderer and node ids of a node the page adopted
into a window-2 document are refused for reads and scroll; paste and native key codes, editing commands
without a key and the middle button (both encodings) are refused, a target whose opener left the window shows no opener, select all then deleteBackward clears a field, and
macOS word deletion still works; a scope close drains its replies even with a backlog and a concurrent command, and a
revoke during it closes at once. Every plugin act needs an act lease (engine.cliActLease {tabId, credential}) on its
tab's current document: without one, input, Ardia.dispatchClick, Page.navigate, Page.reload and
Page.handleJavaScriptDialog answer exactly "ardia: no act lease for this page's current document"; a lease holds its background tab visible
(the engine's SetPluginTabVisibleHold) from before the grant until it ends and its last action returned, so the tab
reports visibilityState visible during the act and hidden afterwards; a wheel outside an act is refused (the lease
answers first), a wheel under a lease with the hold on is acknowledged and scrolls, a wheel under a live lease whose
hold another caller turned off is refused as page hidden, and a plugin wheel admitted and held whose delivery
follows the person's own scroll (tabs.devScrollZoom) within 500 ms answers ardia: busy; a grant names the document id
engine.cliActDocument gave when the act was approved, so a tab that loaded a replacement document since is refused
(document_changed); another credential's lease, an unknown credential and a tab in another window don't count; a
mouse move and an Ardia.dispatchClick held by pluginInputHold under a lease that ended (waited for through the engine's
admission count, never a fixed sleep) are refused at delivery with exactly "ardia: act lease ended before this input
was delivered", as is a command whose 10 s action deadline passed while it still waited to be delivered, even though a new lease was granted meanwhile, and the
click never lands (actLeases.deliveriesRefused); a new document ends the lease (actLeases.endedByDocument), and so
do a back-forward cache round trip (the restored document stays unleased), a renderer exit and the credential's last
session on the tab detaching (a fresh attach is refused until a new grant, then acts); a prerendered page of a leased
tab never acts under the primary page's lease; a cross-site frame's own session gets the act-lease-missing refusal; a
wheel parked before forwarding answers "ardia: not delivered" at #2808's 5 s deadline and frees its slot, so a wheel
under a fresh lease after the 10 s action deadline isn't busy; a Page.navigate to a page that never answers gets the
"ardia: outcome unknown" at 10 s (Chromium started it), its id stays taken until Chromium's late reply, which is
dropped, and a click forwarded with its acks withheld gets the same at 10 s, while a click still parked gets the
act-lease-ended refusal; revoking the
credential leaves no lease live; and after the
control server restarts no lease survives, an old id releases nothing and new ids keep counting. The CLI answers a page's showOpenFilePicker, showSaveFilePicker and
showDirectoryPicker with Ardia.answerFilePicker (no dialog opens), and a plugin is refused that command. The app's
file eval runs through its perf probe, so a release build works.`;
const [appArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
if (app.startsWith("/Applications/")) throw new Error("never an installed app");

const work = mkdtempSync(join(tmpdir(), "ac-token-kinds-"));
const data = join(work, "d");
mkdirSync(data);

const DRAG_LOG = `window.dragLog = [];
for (const type of ["dragstart", "dragend", "dragenter", "dragover", "drop"]) document.addEventListener(type, (e) => { if (type !== "dragstart" && type !== "dragend") e.preventDefault(); dragLog.push(type + ":" + (e.target.id || e.target.nodeName)); if (type === "dragstart") window.onArdiaDragstart?.(); }, true);`;
const XCHILD = `<!doctype html><title>xchild</title>
<div id=drag draggable=true style="position:fixed;left:10px;top:10px;width:80px;height:30px;background:#ccc">drag</div>
<div id=drop style="position:fixed;left:10px;top:60px;width:80px;height:30px;background:#eee">drop</div>
<script>${DRAG_LOG}</script>`;
const PICKERS = `<textarea id=area style="position:fixed;left:240px;top:40px;width:200px;height:60px"></textarea>
<button id=open style="position:fixed;left:0;top:40px;width:200px;height:40px">open</button>
<button id=save style="position:fixed;left:0;top:90px;width:200px;height:40px">save</button>
<button id=dir style="position:fixed;left:0;top:140px;width:200px;height:40px">dir</button>
<div id=drag draggable=true style="position:fixed;left:240px;top:120px;width:80px;height:30px;background:#ccc">drag</div>
<div id=drop style="position:fixed;left:240px;top:170px;width:80px;height:30px;background:#eee">drop</div>
<button id=clicker style="position:fixed;left:0;top:200px;width:200px;height:30px">click</button>
<template id=tpl><p id=tplp>template</p></template>
<div id=capture style="position:fixed;left:0;top:240px;width:200px;height:30px;background:#ddd">capture</div>
<script>
${DRAG_LOG}
window.clicks = 0;
clicker.onclick = () => window.clicks++;
document.body.dataset.visibility = document.visibilityState;
document.addEventListener("visibilitychange", () => { document.body.dataset.visibility = document.visibilityState; });
window.captureLog = [];
capture.addEventListener("pointerdown", (e) => { capture.setPointerCapture(e.pointerId); captureLog.push("pointerdown"); });
for (const type of ["gotpointercapture", "pointerup", "lostpointercapture"]) capture.addEventListener(type, () => captureLog.push(type));
const report = (p) => p.then((v) => (window.picked = v), (e) => (window.picked = "error:" + e.name));
open.onclick = () => report(showOpenFilePicker().then(async ([h]) => "open:" + h.name + ":" + (await (await h.getFile()).text())));
save.onclick = () => report(showSaveFilePicker().then(async (h) => { const w = await h.createWritable(); await w.write("saved by the page"); await w.close(); return "save:" + h.name; }));
dir.onclick = () => report(showDirectoryPicker().then(async (d) => { window.dirHandle = d; const names = []; for await (const [n] of d.entries()) names.push(n); return "dir:" + names.sort().join(","); }));
</script>`;
const VIS = `<!doctype html><title>vis</title><p id=vis>-</p><p id=scrolled>0</p><div style="height:5000px"></div>
<script>const show = () => (vis.textContent = document.visibilityState); show(); document.addEventListener("visibilitychange", show);
addEventListener("scroll", () => (scrolled.textContent = String(Math.round(scrollY))), { passive: true });</script>`;
let port = 0;
const hanging = [];
const requested = [];
const answerHanging = () => hanging.splice(0).forEach((answer) => answer());
const server = createServer((req, res) => {
  requested.push(req.url);
  res.setHeader("content-type", "text/html");
  if (req.url === "/child") return res.end(`<!doctype html><title>child</title><p id=childp>child</p><h1 style="position:fixed;left:100px;top:0;margin:0;font-size:12px">ardia child heading</h1>
<div id=drag draggable=true style="position:fixed;left:10px;top:5px;width:80px;height:25px;background:#ccc">drag</div>
<div id=drop style="position:fixed;left:10px;top:45px;width:80px;height:25px;background:#eee">drop</div><script>${DRAG_LOG}</script>`);
  if (req.url === "/xchild") return res.end(XCHILD);
  if (req.url === "/vis") return res.end(VIS);
  const frames = req.url === "/one" ? `<iframe id=child src="/child" style="position:fixed;left:460px;top:40px;width:160px;height:80px"></iframe><iframe id=xsite src="http://localhost:${port}/xchild" style="position:fixed;left:460px;top:140px;width:160px;height:120px"></iframe>` : "";
  const answer = () => res.end(`<!doctype html><title>${req.url.slice(1)}</title><input type=file id=f>${PICKERS}${frames}`);
  if (req.url.startsWith("/slow")) setTimeout(answer, 3000);
  else if (req.url.startsWith("/hang")) hanging.push(answer);
  else answer();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const certDir = mkdtempSync(join(tmpdir(), "ac-token-kinds-cert-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
const certPem = readFileSync(join(certDir, "cert.pem"));
const spki = createHash("sha256").update(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
const secure = createSecureServer({ key: readFileSync(join(certDir, "key.pem")), cert: certPem }, (req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>secure</title><p id=secure>ardia secure fixture</p>`);
});
await new Promise((r) => secure.listen(0, "127.0.0.1", r));
const secureOrigin = `https://127.0.0.1:${secure.address().port}`;

writeFileSync(join(data, "session.json"), JSON.stringify(session({
  settings: { cliControl: true },
  windows: [{ id: "w1" }, { id: "w2" }],
  tabs: [{ id: "t1", windowId: "w1", url: `${origin}/one` }, { id: "t3", windowId: "w1", url: `${origin}/three` }, { id: "t4", windowId: "w1", url: `${origin}/vis` }, { id: "t2", windowId: "w2", url: `${origin}/two` }],
})));
writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
writeFileSync(join(data, "perf-probe"), "");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const until = async (what, fn, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
let evals = 0;
const appEval = async (body) => {
  const id = `k${process.pid}-${++evals}`;
  writeFileSync(join(data, "dev-eval.js"), `// ${id}\n${body}`);
  return until(`eval ${id}`, async () => {
    const out = JSON.parse(readFileSync(join(data, "dev-eval-result.json"), "utf8"));
    if (out.id !== id) return null;
    writeFileSync(join(data, "dev-eval-result.json"), JSON.stringify({ id }));
    return out.error ? { error: out.error } : { value: out.result };
  }).then((r) => {
    if (r.error) throw new Error(r.error);
    return r.value;
  });
};

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 1;
    const waiting = new Map();
    const events = [];
    const replies = [];
    ws.onopen = () => resolve({
      ws, events, replies,
      closed: new Promise((r) => ws.addEventListener("close", r)),
      raw: (id, method, params = {}, sessionId) => ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })),
      rawJson: (json) => ws.send(json),
      repliesTo: async (id, since, ms) => {
        await sleep(ms);
        return replies.slice(since).filter((m) => m.id === id);
      },
      send: (method, params = {}, sessionId) => new Promise((done) => {
        const id = 1000000 + next++;
        waiting.set(id, done);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => waiting.delete(id) && done({ error: { message: "timed out" } }), 15000);
      }),
    });
    ws.onerror = () => reject(new Error("websocket refused"));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) replies.push(m);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.id === undefined) events.push(m);
    };
  });
}
const refused = (reply) => !!reply.error;
const text = (reply) => (!reply ? "no reply" : reply.error ? reply.error.message : JSON.stringify(reply.result).slice(0, 120));

const testEnv = Object.entries(launchVariables({ instance: { chromiumSwitches: `--ignore-certificate-errors-spki-list=${spki}` }, test: { privatePasteboard: true, pluginInputHold: true } })).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, ...testEnv, app]);
const controlFile = join(data, "Chromium", "ArdiaControl.json");
let pid = null;
try {
  await until("ArdiaControl.json", async () => existsSync(controlFile) && statSync(controlFile).size > 0, 90000);
  const control = JSON.parse(readFileSync(controlFile, "utf8"));
  pid = control.pid;
  const engineStatus = await appEval(`return ac.engine.call("engine.cliControlStatus")`).catch(() => null);
  if (engineStatus?.privatePasteboard !== true || engineStatus?.pluginInputHold !== true) {
    console.log("ABORT  the engine didn't confirm its test flags (privatePasteboard, pluginInputHold), so no step ran: this needs a test build, and the general pasteboard is never used");
    throw new Error("test flags not confirmed");
  }
  check("the engine confirms its private pasteboard and plugin input hold before any step", true);
  const base = `ws://127.0.0.1:${control.port}${control.browser}`;

  const cli = await connect(`${base}?token=${control.token}`);
  const urlsOf = async (c) => ((await c.send("Target.getTargets")).result?.targetInfos ?? []).filter((t) => t.type === "page").map((t) => t);
  const pages = await until("both windows' pages", async () => {
    const all = await urlsOf(cli);
    const one = all.find((t) => t.url === `${origin}/one`), two = all.find((t) => t.url === `${origin}/two`);
    return one && two ? { one, two } : null;
  });
  const chrome = await cli.send("Target.createTarget", { url: "chrome://version", background: true });
  const chromeSession = chrome.result && (await cli.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true }));
  check("cli: a chrome:// page attaches", !!chromeSession?.result?.sessionId, text(chromeSession ?? chrome));
  const cliDownloads = await cli.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") });
  check("cli: Browser.setDownloadBehavior answers", !refused(cliDownloads), text(cliDownloads));
  const cliBrowser = await cli.send("Target.attachToBrowserTarget");
  check("cli: the browser target attaches", !!cliBrowser.result?.sessionId, text(cliBrowser));
  const cliTwo = await cli.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("cli: a page in either window attaches", !!cliTwo.result?.sessionId, text(cliTwo));

  const minted = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t1" })`);
  check("a plugin credential is minted for window 1", !!minted?.credential && !!minted?.id, JSON.stringify(minted ?? null).replace(/"credential":"[^"]+"/, '"credential":"…"'));
  check("the plugin credential isn't in ArdiaControl.json", !readFileSync(controlFile, "utf8").includes(minted.credential));
  const active = await fetch(`http://127.0.0.1:${control.port}/ardia/active?token=${encodeURIComponent(minted.credential)}`).then((r) => r.status, () => 0);
  check("the plugin credential can't read /ardia/active", active !== 200, String(active));

  const plugin = await connect(`${base}?token=${encodeURIComponent(minted.credential)}`);
  const documentOf = (tabId, credential = minted.id) =>
    appEval(`return ac.engine.call("engine.cliActDocument", { tabId: ${JSON.stringify(tabId)}, credential: ${JSON.stringify(credential)} })`).catch((e) => ({ error: String(e?.message ?? e) }));
  const leaseFor = (tabId, document, credential = minted.id) =>
    appEval(`return ac.engine.call("engine.cliActLease", { tabId: ${JSON.stringify(tabId)}, credential: ${JSON.stringify(credential)}, document: ${Number(document)} })`).catch((e) => ({ error: String(e?.message ?? e) }));
  const leaseOf = async (tabId, credential = minted.id) => {
    const approved = await documentOf(tabId, credential);
    return approved?.error ? approved : leaseFor(tabId, approved?.document, credential);
  };
  const releaseLease = (lease) => appEval(`return ac.engine.call("engine.cliActRelease", { lease: ${Number(lease)} })`).catch(() => null);
  const heldLeases = new Map();
  const holdTab = async (tabId) => {
    if (heldLeases.has(tabId)) await releaseLease(heldLeases.get(tabId));
    const granted = await leaseOf(tabId);
    heldLeases.set(tabId, granted?.lease);
    return granted?.lease;
  };
  const leaseTotals = async () => (await appEval(`return ac.engine.call("engine.cliControlStatus")`))?.actLeases ?? {};
  const inputAdmitted = async () => (await appEval(`return ac.engine.call("engine.cliControlStatus")`))?.commandsByDomain?.input ?? -1;
  const afterAdmission = async (send) => {
    const before = await inputAdmitted();
    send();
    return until("the engine to admit the input command", async () => ((await inputAdmitted()) > before) || null, 5000).then(() => true, () => false);
  };
  const LEASE_MISSING = "ardia: no act lease for this page's current document";
  const LEASE_ENDED = "ardia: act lease ended before this input was delivered";
  const OUTCOME_UNKNOWN = "ardia: outcome unknown";
  const noLease = (reply) => refused(reply) && reply.error?.message === LEASE_MISSING;
  const leaseEnded = (reply) => !!reply && refused(reply) && reply.error?.message === LEASE_ENDED;
  const leasedSend = async (tabId, method, params, session) => {
    let reply = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await holdTab(tabId);
      reply = await plugin.send(method, params, session);
      if (!noLease(reply)) return reply;
      await sleep(300);
    }
    return reply;
  };
  const seen = (await urlsOf(plugin)).map((t) => t.url);
  check("plugin: Target.getTargets is filtered to window 1's web pages", seen.includes(`${origin}/one`) && !seen.includes(`${origin}/two`) && seen.every((u) => u.startsWith(origin)), seen.join(" "));
  const own = await plugin.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true });
  const ps = own.result?.sessionId;
  check("plugin: window 1's page attaches", !!ps, text(own));
  const hold = (tabId, visible, id = minted.id) => appEval(`return ac.engine.call("engine.cliPluginCredential", { id: ${JSON.stringify(id)}, tabId: ${JSON.stringify(tabId)}, visible: ${visible} }).then((v) => v, (e) => ({ error: String(e?.message ?? e) }))`);
  const tabHolds = async () => (await appEval(`return ac.engine.call("engine.cliControlStatus")`))?.pluginTabHolds;
  const holdsAtAttach = await tabHolds();
  check("plugin: attaching takes no visibility hold", holdsAtAttach === 0, String(holdsAtAttach));
  const t1Hold = await hold("t1", true);
  check("plugin: a hold on its attached tab answers visible", t1Hold?.visible === true && (await tabHolds()) === 1, JSON.stringify(t1Hold));
  const other = await plugin.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("plugin: window 2's page is refused", refused(other), text(other));
  const chromeAttach = await plugin.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true });
  check("plugin: a chrome:// attach is refused", refused(chromeAttach), text(chromeAttach));

  await plugin.send("Page.enable", {}, ps);
  const frameId = (await plugin.send("Page.getFrameTree", {}, ps)).result?.frameTree?.frame?.id;
  for (const [method, params] of [["Runtime.enable", {}], ["Runtime.evaluate", { expression: "1" }], ["Runtime.callFunctionOn", { functionDeclaration: "() => 1", executionContextId: 1 }], ["Runtime.getProperties", { objectId: "1.1.1" }], ["Runtime.releaseObject", { objectId: "1.1.1" }], ["Runtime.releaseObjectGroup", { objectGroup: "x" }], ["Runtime.addBinding", { name: "x" }], ["Page.createIsolatedWorld", { frameId }]]) {
    const reply = await plugin.send(method, params, ps);
    check(`plugin: ${method} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }
  const pluginRoot = async () => (await plugin.send("DOM.getDocument", { depth: -1 }, ps)).result?.root?.nodeId;
  const pluginNode = async (selector) => (await plugin.send("DOM.querySelector", { nodeId: await pluginRoot(), selector }, ps)).result?.nodeId;
  const rootNode = await pluginRoot();
  const nodeIn = async (selector) => (await plugin.send("DOM.querySelector", { nodeId: rootNode, selector }, ps)).result?.nodeId;
  const areaNode = await nodeIn("#area");
  const openNode = await nodeIn("#open");
  const reads = [
    ["DOM.querySelectorAll", { nodeId: rootNode, selector: "button" }, (r) => r.nodeIds?.length === 4],
    ["DOM.getAttributes", { nodeId: openNode }, (r) => r.attributes?.includes("open")],
    ["DOM.getOuterHTML", { nodeId: openNode }, (r) => r.outerHTML?.startsWith("<button")],
    ["DOM.getBoxModel", { nodeId: openNode }, (r) => !!r.model],
    ["DOM.getContentQuads", { nodeId: openNode }, (r) => r.quads?.length > 0],
    ["DOM.describeNode", { nodeId: openNode }, (r) => r.node?.nodeName === "BUTTON"],
    ["DOM.getNodeForLocation", { x: 100, y: 60 }, (r) => !!r.backendNodeId],
    ["Accessibility.getPartialAXTree", { nodeId: openNode }, (r) => r.nodes?.length > 0],
    ["Accessibility.queryAXTree", { nodeId: rootNode, role: "button" }, (r) => r.nodes?.length === 4],
  ];
  for (const [method, params, good] of reads) {
    const reply = await plugin.send(method, params, ps);
    check(`plugin: ${method} answers with plain data`, !refused(reply) && good(reply.result ?? {}), text(reply));
  }
  const objectHandle = await plugin.send("DOM.describeNode", { objectId: "1.1.1" }, ps);
  check("plugin: a Runtime object id is refused on a DOM read", refused(objectHandle) && /objectId/.test(objectHandle.error?.message ?? ""), text(objectHandle));
  const focused = await plugin.send("DOM.focus", { nodeId: areaNode }, ps);
  const shot = await plugin.send("Page.captureScreenshot", {}, ps);
  const scrolled = await plugin.send("DOM.scrollIntoViewIfNeeded", { nodeId: openNode }, ps);
  const emulatedFocus = await plugin.send("Emulation.setFocusEmulationEnabled", { enabled: true }, ps);
  check("plugin: DOM.focus, DOM.scrollIntoViewIfNeeded, Page.captureScreenshot and Emulation.setFocusEmulationEnabled are refused", [focused, scrolled, shot, emulatedFocus].every((r) => refused(r) && /plugin/.test(r.error?.message ?? "")), [focused, scrolled, shot, emulatedFocus].map(text).join(" | "));
  const unleased = [
    await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, ps),
    await plugin.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a", windowsVirtualKeyCode: 65 }, ps),
    await plugin.send("Input.insertText", { text: "x" }, ps),
    await plugin.send("Ardia.dispatchClick", { x: 100, y: 60 }, ps),
    await plugin.send("Page.reload", {}, ps),
    await plugin.send("Page.navigate", { url: `${origin}/one` }, ps),
    await plugin.send("Page.handleJavaScriptDialog", { accept: true }, ps),
  ];
  check("lease: without an act lease, a plugin's input, clicks, navigation, reload and dialog answers answer exactly the act-lease-missing refusal", unleased.every(noLease), unleased.map(text).join(" | "));
  const unleasedRead = await plugin.send("DOM.getBoxModel", { nodeId: openNode }, ps);
  check("lease: a read needs no lease", !refused(unleasedRead), text(unleasedRead));
  const otherMinted = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t1" })`);
  const otherPlugin = await connect(`${base}?token=${encodeURIComponent(otherMinted.credential)}`);
  await otherPlugin.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true });
  const foreignLease = await leaseOf("t1", otherMinted?.id);
  const foreignMove = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, ps);
  check("lease: another credential's lease on the same page doesn't let this plugin act", typeof foreignLease?.lease === "number" && noLease(foreignMove), `${JSON.stringify(foreignLease)} ${text(foreignMove)}`);
  await releaseLease(foreignLease?.lease);
  otherPlugin.ws.close();
  await appEval(`return ac.engine.call("engine.cliPluginCredential", { revoke: ${JSON.stringify(otherMinted?.id)} })`);
  const elsewhere = await leaseOf("t2");
  check("lease: a tab in another window can't be leased", typeof elsewhere?.lease !== "number" && /out of scope/.test(elsewhere?.error ?? ""), JSON.stringify(elsewhere));
  const unknownCredential = await leaseOf("t1", "plugin-0000000000000000");
  check("lease: an unknown credential can't be leased", typeof unknownCredential?.lease !== "number" && /unknown credential/.test(unknownCredential?.error ?? ""), JSON.stringify(unknownCredential));
  const firstLease = await holdTab("t1");
  check("lease: a lease is granted on its own window's tab", typeof firstLease === "number", String(firstLease));
  const releasedTwice = [await releaseLease(firstLease), await releaseLease(firstLease)];
  const afterRelease = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 6 }, ps);
  check("lease: a released lease admits nothing, and releasing it again answers false", releasedTwice[0]?.released === true && releasedTwice[1]?.released === false && noLease(afterRelease), `${JSON.stringify(releasedTwice)} ${text(afterRelease)}`);
  heldLeases.delete("t1");
  await holdTab("t1");
  const cliEarly = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  const earlyValue = async (expression) => (await cli.send("Runtime.evaluate", { expression, returnByValue: true }, cliEarly)).result?.result?.value;
  const clickerQuad = (await plugin.send("DOM.getContentQuads", { nodeId: await nodeIn("#clicker") }, ps)).result?.quads?.[0] ?? [0, 0, 0, 0, 0, 0, 0, 0];
  const clickerX = (clickerQuad[0] + clickerQuad[4]) / 2, clickerY = (clickerQuad[1] + clickerQuad[5]) / 2;
  const capturedBefore = await leaseTotals();
  const clicksBeforeHeld = await earlyValue("window.clicks");
  const capturedMark = plugin.replies.length;
  const moveAdmitted = await afterAdmission(() => plugin.raw(650001, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 }, ps));
  const clickAdmitted = await afterAdmission(() => plugin.raw(650011, "Ardia.dispatchClick", { x: clickerX, y: clickerY }, ps));
  await holdTab("t1");
  const laterAdmitted = await afterAdmission(() => plugin.raw(650002, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 9, y: 9 }, ps));
  const heldMove = await until("the held move's answer", async () => plugin.replies.slice(capturedMark).find((m) => m.id === 650001) ?? null, 8000).catch(() => null);
  const heldClick = await until("the held click's answer", async () => plugin.replies.slice(capturedMark).find((m) => m.id === 650011) ?? null, 8000).catch(() => null);
  const laterMove = await until("the later move's answer", async () => plugin.replies.slice(capturedMark).find((m) => m.id === 650002) ?? null, 8000).catch(() => null);
  const clicksAfterHeld = await earlyValue("window.clicks");
  const capturedAfter = await leaseTotals();
  check("lease: a mouse move and an Ardia.dispatchClick held under a lease that ended are refused at delivery with exactly the act-lease-ended refusal, though a newer lease covers the page; the click never lands, and input under the newer lease lands",
    moveAdmitted && clickAdmitted && laterAdmitted && leaseEnded(heldMove) && leaseEnded(heldClick) && clicksAfterHeld === clicksBeforeHeld && laterMove && !refused(laterMove) && capturedAfter.deliveriesRefused - capturedBefore.deliveriesRefused === 2,
    `${text(heldMove ?? {})} | ${text(heldClick ?? {})} | ${text(laterMove ?? {})} clicks ${clicksBeforeHeld} -> ${clicksAfterHeld} ${JSON.stringify(capturedAfter)}`);
  const withheld = [
    await plugin.send("DOM.focus", { nodeId: areaNode }, ps),
    await plugin.send("Page.captureScreenshot", {}, ps),
    await plugin.send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } }, ps),
  ];
  check("lease: DOM.focus and Page.captureScreenshot are refused for a plugin even under a live lease", withheld.every((r) => refused(r) && /isn't allowed for a plugin/.test(r.error?.message ?? "")), withheld.map(text).join(" | "));
  const wheel = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 60, deltaX: 0, deltaY: 50 }, ps);
  check("plugin: a mouseWheel event answers", !refused(wheel), text(wheel));

  const visTarget = await until("the background vis tab", async () => (await urlsOf(plugin)).find((t) => t.url === `${origin}/vis`) ?? null);
  const visAttach = await plugin.send("Target.attachToTarget", { targetId: visTarget.targetId, flatten: true });
  const p4 = visAttach.result?.sessionId;
  const textOf = async (session, id) => {
    const root = (await plugin.send("DOM.getDocument", {}, session)).result?.root?.nodeId;
    const node = root && (await plugin.send("DOM.querySelector", { nodeId: root, selector: `#${id}` }, session)).result?.nodeId;
    return node ? ((await plugin.send("DOM.getOuterHTML", { nodeId: node }, session)).result?.outerHTML ?? "").replace(/<[^>]+>/g, "") : null;
  };
  const visState = (session) => until("the vis page", async () => { const v = await textOf(session, "vis"); return v && v !== "-" ? v : null; }, 10000).catch(() => null);
  const visBefore = await visState(p4);
  check("plugin: a background tab it attached to without a hold reports visibilityState hidden", !!p4 && visBefore === "hidden", `${text(visAttach)} ${visBefore}`);
  const wheelHidden = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 300 }, p4);
  check("lease: a wheel to that tab outside an act (no lease, no hold) is refused, the lease first (the act-lease-missing refusal)", noLease(wheelHidden), text(wheelHidden));
  const holdOutOfScope = await hold("t2", true);
  check("plugin: a hold on another window's tab is refused (tab out of scope)", /tab out of scope/.test(holdOutOfScope?.error ?? ""), JSON.stringify(holdOutOfScope));
  const holdNoSession = await hold("t3", true);
  check("plugin: a hold on a tab it has no session with is refused (no attached session)", /no attached session/.test(holdNoSession?.error ?? ""), JSON.stringify(holdNoSession));
  const holdOther = await hold("t4", true, "plugin-0000000000000000");
  check("plugin: a hold for an unknown credential is refused (no such credential)", /no such credential/.test(holdOther?.error ?? ""), JSON.stringify(holdOther));
  const holdsBefore = await tabHolds();
  const visOn = await hold("t4", true);
  const visOnAgain = await hold("t4", true);
  const holdsOn = await tabHolds();
  check("plugin: a hold on its background tab answers visible, and a second one adds nothing", visOn?.visible === true && visOnAgain?.visible === true && holdsOn === holdsBefore + 1, `${JSON.stringify(visOn)} ${JSON.stringify(visOnAgain)} holds ${holdsBefore} -> ${holdsOn}`);
  const visHeld = await until("visibilityState visible", async () => ((await textOf(p4, "vis")) === "visible" ? "visible" : null), 10000).catch(() => null);
  check("plugin: with the hold, the background tab reports visibilityState visible and stays in the background", visHeld === "visible", String(visHeld));
  const t4Lease = await leaseOf("t4");
  check("lease: a lease on the held background tab is granted (its hold is already on, so turning it on again changes nothing)", typeof t4Lease?.lease === "number" && (await tabHolds()) === holdsBefore + 1, JSON.stringify(t4Lease));
  const wheelHeld = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 300 }, p4);
  const scrolledHeld = await until("the held tab to scroll", async () => (Number(await textOf(p4, "scrolled")) > 0 ? Number(await textOf(p4, "scrolled")) : null), 8000).catch(() => 0);
  check("plugin: under a lease, with the hold on, a wheel to the background tab is acknowledged and scrolls it", !refused(wheelHeld) && scrolledHeld > 0, `${text(wheelHeld)} scrollY ${scrolledHeld}`);
  const pairMark = plugin.replies.length;
  plugin.raw(664001, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 100 }, p4);
  plugin.raw(664002, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 100 }, p4);
  const firstOfPair = await until("the first wheel's reply", async () => plugin.replies.slice(pairMark).find((m) => m.id === 664001) ?? null, 8000).catch(() => null);
  const secondOfPair = plugin.replies.slice(pairMark).find((m) => m.id === 664002);
  check("plugin: two back-to-back wheels: the first is acknowledged, the second answers busy while the first is outstanding", !!firstOfPair && !firstOfPair.error && !!secondOfPair && secondOfPair.error?.message === "ardia: busy", `${firstOfPair ? text(firstOfPair) : "no reply"} | ${secondOfPair ? text(secondOfPair) : "no reply"}`);
  const visOff = await hold("t4", false);
  const visOffAgain = await hold("t4", false);
  const visReleased = await until("visibilityState hidden", async () => ((await textOf(p4, "vis")) === "hidden" ? "hidden" : null), 10000).catch(() => null);
  const wheelReleased = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 300 }, p4);
  check("plugin: turning the hold off (twice) while the lease is still live hides the tab again and its wheels are refused (page hidden)", visOff?.visible === false && visOffAgain?.visible === false && visReleased === "hidden" && refused(wheelReleased) && /page hidden/.test(wheelReleased.error?.message ?? "") && (await tabHolds()) === holdsBefore, `${JSON.stringify(visOff)} ${visReleased} ${text(wheelReleased)}`);
  await releaseLease(t4Lease?.lease);
  await holdTab("t1");
  const calmWheel = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 300, deltaX: 0, deltaY: 40 }, ps);
  const pointerTest = (args) => appEval(`return ac.engine.call("engine.cliTestPointer", ${JSON.stringify(args)})`).catch((e) => ({ error: String(e?.message ?? e) }));
  const parkedNow = (count) => until(`${count} parked pointer runs`, async () => ((await pointerTest({}))?.parked === count) || null, 8000).then(() => true, () => false);
  const replyTo = (client, mark, id, ms = 8000) => until(`the reply to ${id}`, async () => client.replies.slice(mark).find((m) => m.id === id) ?? null, ms).catch(() => null);
  const busyMark = plugin.replies.length;
  await pointerTest({ park: true });
  const wheelAdmitted = await afterAdmission(() => plugin.raw(650021, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 300, deltaX: 0, deltaY: 40 }, ps));
  const wheelParked = await parkedNow(1);
  const personScrolled = await appEval(`return ac.engine.call("tabs.devScrollZoom", { steps: [{ phase: "wheel", dy: 1 }], tabId: "t1" })`).catch((e) => ({ error: String(e?.message ?? e) }));
  const busyReleased = await pointerTest({ release: true });
  const busyWheel = await replyTo(plugin, busyMark, 650021);
  await sleep(700);
  const afterBusy = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 300, deltaX: 0, deltaY: 40 }, ps);
  check("lease: a plugin wheel under a lease works; one admitted and parked at hit-test completion, released right after the person's own scroll, answers ardia: busy; and wheels work again after",
    !refused(calmWheel) && wheelAdmitted && wheelParked && !personScrolled?.error && busyReleased?.released === 1 && busyWheel && /ardia: busy/.test(busyWheel.error?.message ?? "") && !refused(afterBusy),
    `${text(calmWheel)} | admitted ${wheelAdmitted} parked ${wheelParked} | person ${JSON.stringify(personScrolled)} | ${JSON.stringify(busyReleased)} | ${text(busyWheel ?? {})} | ${text(afterBusy)}`);
  const [deadlineX, deadlineY] = [clickerX, clickerY];
  const expiredLease = await holdTab("t1");
  const expiredBefore = await pointerTest({});
  const expiredClicks = await earlyValue("window.clicks");
  const expiredMark = plugin.replies.length;
  await pointerTest({ park: true });
  const expiredAdmitted = await afterAdmission(() => plugin.raw(650031, "Ardia.dispatchClick", { x: deadlineX, y: deadlineY }, ps));
  const expiredParked = await parkedNow(1);
  await releaseLease(expiredLease);
  heldLeases.delete("t1");
  const expiredReply = await replyTo(plugin, expiredMark, 650031, 14000);
  const holdsAfterExpiry = await until("the hold to end with the expired action", async () => (await pointerTest({}))?.holds === 0 || null, 4000).then(() => 0, () => -1);
  await pointerTest({ release: true });
  await sleep(1000);
  const expiredAfter = await pointerTest({});
  const expiredReplies = plugin.replies.slice(expiredMark).filter((m) => m.id === 650031);
  check("lease: a click parked past its 10 s deadline gets exactly the act-lease-ended refusal, the hold ends, and once released nothing is forwarded, no recovery release goes out and no second reply arrives",
    expiredAdmitted && expiredParked && leaseEnded(expiredReply) && holdsAfterExpiry === 0 && (await earlyValue("window.clicks")) === expiredClicks && expiredAfter.recoveries === expiredBefore.recoveries && expiredReplies.length === 1,
    `${text(expiredReply ?? {})} holds ${holdsAfterExpiry} replies ${expiredReplies.length} ${JSON.stringify(expiredAfter)}`);
  const spanLease = await holdTab("t1");
  const spanBefore = await pointerTest({});
  const spanMark = plugin.replies.length;
  await pointerTest({ park: true, withholdAcks: true });
  const spanStart = Date.now();
  const spanAdmitted = await afterAdmission(() => plugin.raw(650041, "Ardia.dispatchClick", { x: deadlineX, y: deadlineY }, ps));
  const spanParked = await parkedNow(1);
  await sleep(Math.max(0, 6000 - (Date.now() - spanStart)));
  await pointerTest({ release: true });
  await releaseLease(spanLease);
  heldLeases.delete("t1");
  const spanReply = await replyTo(plugin, spanMark, 650041, 10000);
  const spanReplyAt = Date.now() - spanStart;
  const holdsAfterSpan = await until("the hold to end after the span", async () => (await pointerTest({}))?.holds === 0 || null, 4000).then(() => 0, () => -1);
  await sleep(Math.max(0, 12500 - (Date.now() - spanStart)));
  const spanAfter = await pointerTest({ withholdAcks: false });
  const spanReplies = plugin.replies.slice(spanMark).filter((m) => m.id === 650041);
  check("lease: a click forwarded at 6 s with its acks withheld spans the 5 s ack deadline and the 10 s action deadline: delivery had started, so the client gets one ardia: outcome unknown at the action deadline, the hold ends, and no recovery release goes out after the ticket expired",
    spanAdmitted && spanParked && spanReply?.error?.message === OUTCOME_UNKNOWN && spanReplyAt < 11500 && holdsAfterSpan === 0 && spanAfter.recoveries === spanBefore.recoveries && spanReplies.length === 1,
    `${text(spanReply ?? {})} at ${spanReplyAt} ms holds ${holdsAfterSpan} replies ${spanReplies.length} ${JSON.stringify(spanAfter)}`);
  await holdTab("t1");
  const slotMark = plugin.replies.length;
  await pointerTest({ park: true });
  const slotStart = Date.now();
  const slotAdmitted = await afterAdmission(() => plugin.raw(650051, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 300, deltaX: 0, deltaY: 40 }, ps));
  const slotParked = await parkedNow(1);
  const slotReply = await replyTo(plugin, slotMark, 650051, 14000);
  const slotReplyAt = Date.now() - slotStart;
  await sleep(Math.max(0, 10500 - (Date.now() - slotStart)));
  await pointerTest({ release: true });
  await holdTab("t1");
  const slotFresh = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 300, deltaX: 0, deltaY: 40 }, ps);
  const slotReplies = plugin.replies.slice(slotMark).filter((m) => m.id === 650051);
  check("lease: a wheel parked before forwarding answers ardia: not delivered at #2808's 5 s pre-forward deadline, frees its slot, and after the 10 s action deadline a wheel under a fresh lease isn't busy",
    slotAdmitted && slotParked && slotReply?.error?.message === "ardia: not delivered" && slotReplyAt < 9000 && slotReplies.length === 1 && !refused(slotFresh),
    `${text(slotReply ?? {})} at ${slotReplyAt} ms replies ${slotReplies.length} | ${text(slotFresh)}`);
  const navLease = await holdTab("t1");
  const navMark = plugin.replies.length;
  const navStart = Date.now();
  plugin.raw(650061, "Page.navigate", { url: `${origin}/hang` }, ps);
  const navReply = await replyTo(plugin, navMark, 650061, 14000);
  const navReplyAt = Date.now() - navStart;
  await releaseLease(navLease);
  heldLeases.delete("t1");
  const holdsAfterNav = await until("the hold to end with the expired navigation", async () => (await pointerTest({}))?.holds === 0 || null, 4000).then(() => 0, () => -1);
  const navDuplicateMark = plugin.replies.length;
  plugin.raw(650061, "DOM.getDocument", {}, ps);
  const navDuplicate = await replyTo(plugin, navDuplicateMark, 650061, 4000);
  answerHanging();
  const navCommitted = await until("the slow navigation to commit", async () => (await earlyValue("location.pathname")) === "/hang" || null, 10000).then(() => true, () => false);
  await sleep(1000);
  const navReplies = plugin.replies.slice(navMark).filter((m) => m.id === 650061);
  const navReuseMark = plugin.replies.length;
  plugin.raw(650061, "DOM.getDocument", {}, ps);
  const navReuse = await replyTo(plugin, navReuseMark, 650061, 4000);
  check("lease: a Page.navigate Chromium started but doesn't answer within 10 s gets ardia: outcome unknown at the action deadline (delivery can't be ruled out) and the hold ends; its id stays taken as a tombstone until Chromium's late reply, which is dropped, then the id is free again",
    navReply?.error?.message === OUTCOME_UNKNOWN && navReplyAt >= 9500 && navReplyAt < 11500 && holdsAfterNav === 0 && navDuplicate?.error?.message === "ardia: a command with that id is still waiting for its reply" && navCommitted && navReplies.length === 2 && !refused(navReuse),
    `${text(navReply ?? {})} at ${navReplyAt} ms holds ${holdsAfterNav} | ${text(navDuplicate ?? {})} | committed ${navCommitted} | ${navReplies.map(text).join(" | ")} | ${text(navReuse ?? {})}`);
  await cli.send("Page.navigate", { url: `${origin}/one` }, cliEarly);
  await until("t1 to load /one again", async () => (await earlyValue("location.pathname === '/one' && document.readyState === 'complete' && !!document.getElementById('xsite')")) || null, 15000).catch(() => null);
  await holdTab("t1");
  await hold("t4", true);
  const holdsBeforeDetach = await tabHolds();
  await plugin.send("Target.detachFromTarget", { sessionId: p4 });
  const holdsAfterDetach = await until("the hold to drop on detach", async () => (await tabHolds()) === holdsBeforeDetach - 1 || null, 5000).then(() => holdsBeforeDetach - 1, () => null);
  check("plugin: detaching its last session from the tab drops the hold", holdsAfterDetach === holdsBeforeDetach - 1, `${holdsBeforeDetach} -> ${holdsAfterDetach}`);
  const p4b = (await plugin.send("Target.attachToTarget", { targetId: visTarget.targetId, flatten: true })).result?.sessionId;
  const reheld = await hold("t4", true);
  check("plugin: a fresh session on the tab can take the hold again (it lasts until the revoke)", !!p4b && reheld?.visible === true, JSON.stringify(reheld));
  const tabIn = (tab, win) => until(`${tab} in ${win}`, async () =>
    ((await appEval(`return ac.engine.call("tabs.strips")`))?.strips ?? []).some((s) => s.appWindow === win && s.tabs.some((t) => t.key === tab)) || null, 8000).then(() => true, () => false);
  const p4bDetached = () => plugin.events.some((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === p4b);
  const holdsBeforeMove = await tabHolds();
  await appEval(`ac.actions.moveTabToWindow("t4", "w2"); return true`);
  const droppedOnLeave = await until("the hold to drop as the tab leaves", async () => ((await tabHolds()) === holdsBeforeMove - 1 ? true : null), 3000).catch(() => false);
  const detachedAtDrop = p4bDetached();
  await appEval(`ac.actions.moveTabToWindow("t4", "w1"); return true`);
  const backInWindow = await tabIn("t4", "w1");
  const reacquired = await hold("t4", true);
  const detachedAtReacquire = p4bDetached();
  check("plugin: when its tab leaves the window the hold drops at once, before the session's detach, and a hold after the tab comes back is refused while the old session is still detaching", droppedOnLeave === true && !detachedAtDrop && backInWindow && /no attached session/.test(reacquired?.error ?? "") && !detachedAtReacquire && (await tabHolds()) === holdsBeforeMove - 1, `dropped ${droppedOnLeave} detached at drop ${detachedAtDrop} back ${backInWindow} ${JSON.stringify(reacquired)} detached at re-hold ${detachedAtReacquire}`);
  await until("the old session's detach", async () => p4bDetached() || null, 12000).catch(() => null);
  const p4c = (await plugin.send("Target.attachToTarget", { targetId: visTarget.targetId, flatten: true })).result?.sessionId;
  const heldAgain = await hold("t4", true);
  check("plugin: a fresh session after the return takes the hold again", !!p4c && heldAgain?.visible === true, JSON.stringify(heldAgain));

  const allowed = [
    ["DOM.getDocument", {}],
    ["Accessibility.getFullAXTree", {}],
    ["Page.getLayoutMetrics", {}],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }],
    ["Target.getTargetInfo", { targetId: pages.one.targetId }],
  ];
  for (const [method, params] of allowed) {
    const reply = await plugin.send(method, params, method.startsWith("Target.") ? undefined : ps);
    check(`plugin: ${method} answers`, !refused(reply), text(reply));
  }
  const refusedHere = [
    ["DOM.setFileInputFiles", { files: [join(work, "x")], backendNodeId: 1 }, ps],
    ["DOM.resolveNode", { backendNodeId: 1 }, ps],
    ["DOM.performSearch", { query: "button" }, ps],
    ["DOM.getSearchResults", { searchId: "1", fromIndex: 0, toIndex: 1 }, ps],
    ["DOM.discardSearchResults", { searchId: "1" }, ps],
    ["Input.setInterceptDrags", { enabled: true }, ps],
    ["Page.printToPDF", {}, ps],
    ["Page.addScriptToEvaluateOnNewDocument", { source: "1" }, ps],
    ["Page.startScreencast", {}, ps],
    ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }, ps],
    ["Input.dispatchDragEvent", { type: "dragEnter", x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } }, ps],
    ["Emulation.setDeviceMetricsOverride", { width: 1, height: 1, deviceScaleFactor: 1, mobile: false }, ps],
    ["Target.createTarget", { url: `${origin}/three` }],
    ["Target.setDiscoverTargets", { discover: true }],
    ["Target.activateTarget", { targetId: pages.one.targetId }],
    ["Target.closeTarget", { targetId: pages.one.targetId }],
    ["Target.attachToBrowserTarget", {}],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
    ["Network.enable", {}, ps],
    ["Network.getCookies", {}, ps],
    ["Network.enableDeviceBoundSessions", { enable: true }, ps],
    ["Network.deleteDeviceBoundSession", { key: { site: origin, id: "x" } }, ps],
    ["Fetch.enable", {}, ps],
    ["Storage.getCookies", {}],
    ["IO.read", { handle: "1" }],
    ["Tracing.start", {}],
    ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }],
    ["Overlay.highlightNode", { highlightConfig: {}, backendNodeId: 1 }, ps],
    ["Ardia.answerFilePicker", { kind: "open", paths: ["/etc/hosts"] }, ps],
  ];
  for (const [method, params, sessionId] of refusedHere) {
    const reply = await plugin.send(method, params, sessionId);
    check(`plugin: ${method} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }

  await cli.send("Runtime.evaluate", { expression: "console.log('main world'); location.reload()" }, cliTwo.result?.sessionId);
  const csOne = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  await cli.send("Network.enable", {}, csOne);
  await cli.send("Runtime.evaluate", { expression: "console.log('main world'); fetch(location.href)" }, csOne);
  await sleep(1500);
  const leaked = plugin.events.filter((e) => e.method?.startsWith("Network.") || e.method === "Runtime.consoleAPICalled");
  check("plugin: no Network or console event reaches it", leaked.length === 0, leaked.map((e) => e.method).join(" "));
  const dragPath = (x, from, to) => [["mousePressed", x, from, 1], ["mouseMoved", x, from + 10, 1], ["mouseMoved", x, (from + to) / 2, 1], ["mouseMoved", x, to, 1], ["mouseReleased", x, to, 0]];
  const dragWith = async (client, session, path) => {
    const replies = [];
    for (const [type, x, y, buttons] of path) replies.push(await client.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, session));
    await sleep(500);
    return replies;
  };
  const logOf = async (session) => (await cli.send("Runtime.evaluate", { expression: "(() => { const log = window.dragLog.join(','); window.dragLog = []; return log; })()", returnByValue: true }, session)).result?.result?.value;
  const centerOf = async (session, id) => (await cli.send("Runtime.evaluate", { expression: `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`, returnByValue: true }, session)).result?.result?.value ?? [0, 0];
  const csValue = async (session, expression) => (await cli.send("Runtime.evaluate", { expression, returnByValue: true }, session)).result?.result?.value;
  for (const [name, params] of [
    ["mousePressed", { type: "mousePressed", x: 280, y: 135, button: "left", buttons: 1, clickCount: 1 }],
    ["mouseReleased", { type: "mouseReleased", x: 280, y: 135, button: "left", buttons: 0, clickCount: 1 }],
    ["a move with the left button held", { type: "mouseMoved", x: 280, y: 150, buttons: 1 }],
    ["a move naming a button", { type: "mouseMoved", x: 280, y: 150, button: "left" }],
  ]) {
    const reply = await plugin.send("Input.dispatchMouseEvent", params, ps);
    check(`plugin: Input.dispatchMouseEvent ${name} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }
  const clicksOf = () => csValue(csOne, "window.clicks");
  const clicksBefore = await clicksOf();
  const [clickX, clickY] = await centerOf(csOne, "clicker");
  const clicked = await plugin.send("Ardia.dispatchClick", { x: clickX, y: clickY }, ps);
  const clicksAfter = await clicksOf();
  check("plugin: Ardia.dispatchClick clicks a button once, and answers after the click landed", !refused(clicked) && clicksAfter === clicksBefore + 1, `${text(clicked)} clicks ${clicksBefore} -> ${clicksAfter}`);
  await csValue(csOne, "(() => { const p = document.createElement('p'); p.id = 'words'; p.style.cssText = 'position:fixed;left:0;top:300px;margin:0;font-size:24px'; p.innerHTML = 'alpha <span id=bravo>bravo</span> charlie'; document.body.append(p); getSelection().removeAllRanges(); return true })()");
  const [wordX, wordY] = await centerOf(csOne, "bravo");
  const doubled = await plugin.send("Ardia.dispatchClick", { x: wordX, y: wordY, clickCount: 2 }, ps);
  const selected = await csValue(csOne, "getSelection().toString().trim()");
  check("plugin: Ardia.dispatchClick with clickCount 2 double-clicks a word and selects it", !refused(doubled) && selected === "bravo", `${text(doubled)} selected ${JSON.stringify(selected)}`);
  await logOf(csOne);
  const [dragX, dragY] = await centerOf(csOne, "drag");
  const onDraggable = await plugin.send("Ardia.dispatchClick", { x: dragX, y: dragY }, ps);
  await sleep(500);
  const clickDragLog = await logOf(csOne);
  check("plugin: Ardia.dispatchClick on a draggable element starts no drag (no dragstart)", !refused(onDraggable) && clickDragLog === "", `${text(onDraggable)} log ${JSON.stringify(clickDragLog)}`);
  await plugin.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, ps);
  const xsite = await until("the cross-site frame session", async () => plugin.events.find((e) => e.method === "Target.attachedToTarget" && e.params?.targetInfo?.url?.endsWith("/xchild")) ?? null, 10000).catch(() => null);
  const xsiteSession = xsite?.params?.sessionId;
  const frameClick = xsiteSession && (await plugin.send("Ardia.dispatchClick", { x: 20, y: 20 }, xsiteSession));
  const frameMove = xsiteSession && (await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 20 }, xsiteSession));
  const frameWheel = xsiteSession && (await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 20, y: 20, deltaX: 0, deltaY: 10 }, xsiteSession));
  check("plugin: Ardia.dispatchClick, moves and wheels on a cross-site frame's own session are refused at admission with exactly the act-lease-missing refusal (the lease names the page target only)", !!xsiteSession && [frameClick, frameMove, frameWheel].every((r) => r && noLease(r)), [frameClick, frameMove, frameWheel].map((r) => (r ? text(r) : "none")).join(" | "));
  const xsiteTargetId = xsite?.params?.targetInfo?.targetId;
  const cliFrame = xsiteTargetId && (await cli.send("Target.attachToTarget", { targetId: xsiteTargetId, flatten: true })).result?.sessionId;
  const cliFrameClick = cliFrame && (await cli.send("Ardia.dispatchClick", { x: 20, y: 20 }, cliFrame));
  check("cli: Ardia.dispatchClick on a cross-site frame's own session is refused too (owners keep raw Input there)", !!cliFrameClick && refused(cliFrameClick) && /page target's own session/.test(cliFrameClick.error?.message ?? ""), cliFrameClick ? text(cliFrameClick) : "no session");
  const intoFrame = await plugin.send("Ardia.dispatchClick", { x: 480, y: 160 }, ps);
  check("plugin: a click from the page's own session into a cross-site frame works through hit testing", !refused(intoFrame), text(intoFrame));
  const [captureX, captureY] = await centerOf(csOne, "capture");
  const captured = await plugin.send("Ardia.dispatchClick", { x: captureX, y: captureY }, ps);
  await sleep(300);
  const captureLog = await csValue(csOne, "window.captureLog.join(',')");
  check("plugin: Ardia.dispatchClick releases the button, so a pointer-capture control sees pointerup and lostpointercapture", !refused(captured) && /pointerdown/.test(captureLog ?? "") && /pointerup/.test(captureLog ?? "") && /lostpointercapture/.test(captureLog ?? ""), `${text(captured)} ${captureLog}`);
  const outside = await plugin.send("Ardia.dispatchClick", { x: 100000, y: 10 }, ps);
  check("plugin: Ardia.dispatchClick outside the page's view is refused before hit testing", refused(outside) && /outside the page/.test(outside.error?.message ?? ""), text(outside));
  for (const [name, params] of [["the middle button", { x: clickX, y: clickY, button: "middle" }], ["four clicks", { x: clickX, y: clickY, clickCount: 4 }], ["a negative x", { x: -1, y: clickY }], ["a string clickCount", { x: clickX, y: clickY, clickCount: "2" }]]) {
    const reply = await cli.send("Ardia.dispatchClick", params, csOne);
    check(`cli: Ardia.dispatchClick with ${name} is refused for the owner too`, refused(reply), text(reply));
  }
  for (const [name, json] of [["buttons 1.0", '"buttons":1.0'], ["buttons 0.0", '"buttons":0.0'], ["buttons -0.0", '"buttons":-0.0'], ["buttons \"0\"", '"buttons":"0"'], ["buttons 1e20", '"buttons":1e20'], ["modifiers 2.0", '"modifiers":2.0']]) {
    const mark = plugin.replies.length;
    plugin.rawJson(`{"id":691000,"method":"Input.dispatchMouseEvent","params":{"type":"mouseMoved","x":5,"y":5,${json}},"sessionId":"${ps}"}`);
    const reply = (await plugin.repliesTo(691000, mark, 800))[0];
    check(`plugin: Input.dispatchMouseEvent with ${name} is refused (numbers are checked strictly)`, !!reply && refused(reply) && /plugin/.test(reply.error?.message ?? ""), reply ? text(reply) : "no reply");
  }
  {
    const mark = plugin.replies.length;
    plugin.rawJson(`{"id":691100,"method":"Ardia.dispatchClick","params":{"x":${clickX},"y":${clickY},"clickCount":2.0},"sessionId":"${ps}"}`);
    const reply = (await plugin.repliesTo(691100, mark, 800))[0];
    check("plugin: Ardia.dispatchClick with clickCount 2.0 is refused", !!reply && refused(reply), reply ? text(reply) : "no reply");
  }
  for (const [name, params] of [["the middle button", { x: clickX, y: clickY, button: "middle" }], ["four clicks", { x: clickX, y: clickY, clickCount: 4 }], ["no position", {}], ["an unknown parameter", { x: clickX, y: clickY, force: 1 }]]) {
    const reply = await plugin.send("Ardia.dispatchClick", params, ps);
    check(`plugin: Ardia.dispatchClick with ${name} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }
  await logOf(csOne);
  const ownerDrag = await dragWith(cli, csOne, dragPath(280, 135, 185));
  const ownerLog = await logOf(csOne);
  check("cli: the owner's drag (Input.dispatchMouseEvent press, moves, release) still drags and drops on the drop element", ownerDrag.every((r) => !refused(r)) && /^dragstart:drag,.*dragenter:drop.*dragover:drop.*drop:drop,dragend:drag$/.test(ownerLog ?? ""), `${ownerLog}; ${ownerDrag.map(text).join(" | ")}`);
  const childFrame = (await plugin.send("Page.getFrameTree", {}, ps)).result?.frameTree?.childFrames?.find((f) => f.frame?.url?.endsWith("/child"))?.frame?.id;
  const childAx = childFrame && (await plugin.send("Accessibility.getFullAXTree", { frameId: childFrame }, ps));
  const childNodes = childAx?.result?.nodes ?? [];
  const childRoot = childNodes.find((n) => !n.parentId);
  const childFrameIds = childNodes.map((n) => n.frameId).filter(Boolean);
  const inChildSubtree = (node) => { for (let n = node, hops = 0; n && hops < 200; n = childNodes.find((c) => c.nodeId === n.parentId), hops++) if (n === childRoot) return true; return false; };
  const pierced = JSON.stringify((await plugin.send("DOM.getDocument", { depth: -1, pierce: true }, ps)).result ?? {});
  check("plugin: an in-scope child frame is traversed (frame tree, its accessibility tree by name and frame id, and pierced DOM)", !!childFrame && !refused(childAx) && childRoot?.frameId === childFrame && childNodes.some((n) => n.role?.value === "heading" && n.name?.value === "ardia child heading" && inChildSubtree(n)) && childFrameIds.every((id) => id === childFrame) && pierced.includes("childp"), childAx ? `${childNodes.length} nodes, frame ids ${[...new Set(childFrameIds)].join(",") || "none"}` : "no child frame");
  const runtimeEvents = plugin.events.filter((e) => e.method?.startsWith("Runtime."));
  check("plugin: no Runtime event reaches it", runtimeEvents.length === 0, runtimeEvents.map((e) => e.method).join(" "));
  const activeIs = async (id) => (await cli.send("Runtime.evaluate", { expression: `document.activeElement?.id === ${JSON.stringify(id)}`, returnByValue: true }, csOne)).result?.result?.value === true;
  await csValue(csOne, "document.activeElement?.blur(), true");
  const [areaX, areaY] = await centerOf(csOne, "area");
  const areaClick = await plugin.send("Ardia.dispatchClick", { x: areaX, y: areaY }, ps);
  check("plugin: Ardia.dispatchClick on a field focuses it (plugins focus by clicking, never DOM.focus)", !refused(areaClick) && await activeIs("area"), text(areaClick));

  const key = (extra) => plugin.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, ...extra }, ps);
  const selectAll = await key({ commands: ["selectAll"] });
  check("plugin: Input.dispatchKeyEvent with selectAll answers", !refused(selectAll), text(selectAll));
  const paste = await key({ commands: ["paste"] });
  check("plugin: Input.dispatchKeyEvent with paste is refused", refused(paste) && /plugin/.test(paste.error?.message ?? ""), text(paste));
  const nativeKey = await key({ nativeVirtualKeyCode: 0 });
  check("plugin: Input.dispatchKeyEvent with nativeVirtualKeyCode is refused", refused(nativeKey) && /plugin/.test(nativeKey.error?.message ?? ""), text(nativeKey));
  await cli.send("Emulation.setFocusEmulationEnabled", { enabled: true }, csOne);
  const cliValue = async (expression) => (await cli.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, csOne)).result?.result?.value;
  const cliKey = async (key, code, keyCode, modifiers, commands) => {
    await cli.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(commands ? { commands } : {}) }, csOne);
    await cli.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }, csOne);
  };
  const probe = `ardia-clipboard-probe-${process.pid}`;
  const fillArea = (value, select) => cliValue(`(() => { const a = document.getElementById("area"); a.value = ${JSON.stringify(value)}; a.focus(); ${select ? "a.select();" : "a.setSelectionRange(a.value.length, a.value.length);"} return true })()`);
  const areaValue = () => cliValue(`document.getElementById("area").value`);
  await fillArea(probe, true);
  await cliKey("c", "KeyC", 67, 4, ["copy"]);
  await fillArea("", false);
  await cliKey("v", "KeyV", 86, 4, ["paste"]);
  await sleep(300);
  const roundTrip = await areaValue();
  check("cli: the private pasteboard round-trips (the CLI copies and pastes in a page)", roundTrip === probe, JSON.stringify(roundTrip));
  const clipboardKeys = [...readFileSync(new URL("../../../engine/chromium/src/chrome/browser/ardia/ac_cli_plugin_clipboard_keys.h", import.meta.url), "utf8").matchAll(/\{(\d+), (\d+), "([A-Za-z]*)"\}/g)]
    .map(([, keyCode, modifiers, domKey]) => ({ keyCode: Number(keyCode), modifiers: Number(modifiers), domKey }));
  const pluginFocus = () => cliValue("document.getElementById('area').focus(), true");
  const pluginKey = async (fields) => {
    const down = await plugin.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...fields }, ps);
    await plugin.send("Input.dispatchKeyEvent", { type: "keyUp", ...fields, commands: undefined }, ps);
    return down;
  };
  for (const entry of clipboardKeys) {
    await fillArea("plugin-selected-text", true);
    const reply = await pluginKey({ modifiers: entry.modifiers, ...(entry.domKey ? { key: entry.domKey } : { windowsVirtualKeyCode: entry.keyCode }) });
    await sleep(250);
    const after = await areaValue();
    check(`plugin: clipboard key ${entry.domKey || entry.keyCode} with modifiers ${entry.modifiers} is refused and pastes nothing`, refused(reply) && !String(after).includes(probe), `${text(reply)} area=${JSON.stringify(after)}`);
  }
  await fillArea("", false);
  await pluginFocus();
  await pluginKey({ key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4 });
  await sleep(300);
  const cmdV = await areaValue();
  check("plugin: Cmd+V pastes nothing", !String(cmdV).includes(probe), JSON.stringify(cmdV));
  await fillArea("", false);
  await cliKey("v", "KeyV", 86, 4, ["paste"]);
  await sleep(300);
  const stillProbe = await areaValue();
  check("plugin: its copy and cut attempts left the pasteboard as the CLI set it", stillProbe === probe, JSON.stringify(stillProbe));
  await fillArea("select me", false);
  await pluginFocus();
  const cmdA = await pluginKey({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
  const selection = await cliValue(`(() => { const a = document.getElementById("area"); return a.selectionStart + ":" + a.selectionEnd })()`);
  check("plugin: Cmd+A selects all", !refused(cmdA) && selection === "0:9", `${text(cmdA)} ${selection}`);
  await fillArea("", false);
  await pluginFocus();
  for (const character of "hey") {
    await plugin.send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) }, ps);
    await plugin.send("Input.dispatchKeyEvent", { type: "keyUp", key: character, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) }, ps);
  }
  const typed = await areaValue();
  check("plugin: plain typing still types", typed === "hey", JSON.stringify(typed));
  await pluginFocus();
  await pluginKey({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2, commands: ["selectAll"] });
  const cleared = await pluginKey({ key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, commands: ["deleteBackward"] });
  const afterClear = await areaValue();
  check("plugin: select all then deleteBackward clears a field", !refused(cleared) && afterClear === "", `${text(cleared)} ${JSON.stringify(afterClear)}`);
  await pluginFocus();
  const inserted = await plugin.send("Input.insertText", { text: "zz" }, ps);
  const afterInsert = await areaValue();
  check("plugin: Input.insertText types into the focused field", !refused(inserted) && afterInsert === "zz", `${text(inserted)} ${JSON.stringify(afterInsert)}`);
  for (const accept of [true, false]) {
    const mark = cli.replies.length;
    cli.raw(555000 + Number(accept), "Runtime.evaluate", { expression: "confirm('ardia dialog')", returnByValue: true }, csOne);
    const opened = await until("the dialog", async () => plugin.events.find((e) => e.method === "Page.javascriptDialogOpening" && e.sessionId === ps && !e.handled) ?? null, 8000).catch(() => null);
    if (opened) opened.handled = true;
    const handled = await plugin.send("Page.handleJavaScriptDialog", { accept }, ps);
    const answer = (await cli.repliesTo(555000 + Number(accept), mark, 1500))[0]?.result?.result?.value;
    check(`plugin: Page.handleJavaScriptDialog ${accept ? "accepts" : "cancels"} a dialog`, !!opened && !refused(handled) && answer === accept, `${text(handled)} answer=${answer}`);
  }
  if (process.platform === "darwin") {
    await fillArea("hello world", false);
    await pluginFocus();
    const wordDelete = await pluginKey({ key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 1 });
    const afterWordDelete = await areaValue();
    check("plugin: macOS word deletion (Alt+Backspace) is allowed and deletes a word", !refused(wordDelete) && afterWordDelete === "hello ", `${text(wordDelete)} ${JSON.stringify(afterWordDelete)}`);
  }
  for (const commands of [["paste"], ["copy"]]) {
    const keyless = await plugin.send("Input.dispatchKeyEvent", { type: "rawKeyDown", commands }, ps);
    check(`plugin: editing command ${commands[0]} without a key is refused`, refused(keyless) && /plugin/.test(keyless.error?.message ?? ""), text(keyless));
  }
  for (const [name, params] of [["button middle", { type: "mousePressed", x: 5, y: 5, button: "middle", clickCount: 1 }], ["buttons with the middle bit", { type: "mouseMoved", x: 5, y: 5, buttons: 4 }]]) {
    const middle = await plugin.send("Input.dispatchMouseEvent", params, ps);
    check(`plugin: the middle button (${name}) is refused`, refused(middle) && /plugin/.test(middle.error?.message ?? ""), text(middle));
  }
  const reloadScript = await plugin.send("Page.reload", { scriptToEvaluateOnLoad: "window.ardiaReloadMarker = 1" }, ps);
  await sleep(500);
  const marker = await cli.send("Runtime.evaluate", { expression: "typeof window.ardiaReloadMarker", returnByValue: true }, csOne);
  check("plugin: Page.reload with a script to run on load is refused and the marker never runs", refused(reloadScript) && /plugin/.test(reloadScript.error?.message ?? "") && marker.result?.result?.value === "undefined", `${text(reloadScript)} marker=${text(marker)}`);


  for (const [name, params] of [["referrer", { referrer: origin }], ["referrerPolicy", { referrerPolicy: "unsafeUrl" }], ["transitionType", { transitionType: "typed" }], ["frameId", { frameId }]]) {
    const navigated = await plugin.send("Page.navigate", { url: `${origin}/one`, ...params }, ps);
    check(`plugin: Page.navigate with ${name} is refused`, refused(navigated) && /plugin/.test(navigated.error?.message ?? ""), text(navigated));
  }
  const tree = await plugin.send("Accessibility.getFullAXTree", {}, ps);
  const button = tree.result?.nodes?.find((n) => n.role?.value === "button" && n.backendDOMNodeId);
  const described = await plugin.send("DOM.describeNode", { backendNodeId: button?.backendDOMNodeId }, ps);
  const focusedByBackend = await plugin.send("DOM.getBoxModel", { backendNodeId: button?.backendDOMNodeId }, ps);
  const resolved = await plugin.send("DOM.resolveNode", { backendNodeId: button?.backendDOMNodeId }, ps);
  check("plugin: a backendNodeId from its own tab's accessibility tree describes and boxes, and DOM.resolveNode is refused", !!button && !refused(described) && !refused(focusedByBackend) && refused(resolved), `${text(described)} ${text(focusedByBackend)} ${text(resolved)}`);
  await cli.send("Runtime.evaluate", { expression: `window.popupRef = window.open(${JSON.stringify(`${origin}/four`)}), true`, userGesture: true }, csOne);
  const popup = await until("the popup", async () => (await urlsOf(cli)).find((t) => t.url === `${origin}/four`) ?? null, 15000).catch(() => null);
  const movedPopup = await appEval(`const t = Object.values(ac.store.getState().tabs).find((x) => x?.url?.endsWith("/four")); if (t) ac.actions.moveTabToWindow(t.id, "w2"); return !!t`);
  await sleep(1000);
  const popupSession = popup && (await cli.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true })).result?.sessionId;
  const popupDocument = popupSession && (await cli.send("DOM.getDocument", { depth: 2 }, popupSession));
  const html = popupDocument?.result?.root?.children?.find((c) => c.nodeName === "HTML");
  const foreign = html?.children?.find((c) => c.nodeName === "BODY")?.backendNodeId ?? html?.backendNodeId;
  const crossTab = await plugin.send("DOM.describeNode", { backendNodeId: foreign }, ps);
  check("plugin: a backendNodeId from another tab in the same renderer is refused", !!popup && movedPopup === true && !!foreign && refused(crossTab) && /isn't in this page/.test(crossTab.error?.message ?? ""), text(crossTab));
  for (const method of ["DOM.getBoxModel"]) {
    const crossTabAct = await plugin.send(method, { backendNodeId: foreign }, ps);
    check(`plugin: ${method} on another tab's node is refused`, !!foreign && refused(crossTabAct) && /isn't in this page/.test(crossTabAct.error?.message ?? ""), text(crossTabAct));
  }
  const popupFrameId = popupSession && (await cli.send("Page.getFrameTree", {}, popupSession)).result?.frameTree?.frame?.id;
  const foreignAx = await plugin.send("Accessibility.getFullAXTree", { frameId: popupFrameId }, ps);
  const ownFrames = JSON.stringify((await plugin.send("Page.getFrameTree", {}, ps)).result ?? {});
  const ownTree = JSON.stringify((await plugin.send("DOM.getDocument", { depth: -1, pierce: true }, ps)).result ?? {});
  check("plugin: frame traversal stays in its own page (another tab's frame is refused and never listed)", !!popupFrameId && refused(foreignAx) && !ownFrames.includes(popupFrameId) && !ownTree.includes(popupFrameId), `${text(foreignAx)}`);
  const findNode = (node, test) => test(node) ? node : [...(node.children ?? []), ...(node.templateContent ? [node.templateContent] : []), ...(node.contentDocument ? [node.contentDocument] : [])].map((c) => findNode(c, test)).find(Boolean);
  const mapped = (await plugin.send("DOM.getDocument", { depth: -1 }, ps)).result?.root;
  const tplContent = mapped && findNode(mapped, (n) => n.nodeName === "TEMPLATE" && (n.attributes ?? []).includes("tpl"))?.templateContent?.nodeId;
  const tplNode = tplContent && (await plugin.send("DOM.querySelector", { nodeId: tplContent, selector: "#tplp" }, ps)).result?.nodeId;
  const beforeAdoption = await plugin.send("DOM.getOuterHTML", { nodeId: tplNode }, ps);
  const adopted = (await cli.send("Runtime.evaluate", { expression: "(() => { const t = window.opener?.document.getElementById('tpl'); if (!t) return false; document.body.append(document.adoptNode(t)); return true })()", returnByValue: true }, popupSession)).result?.result?.value;
  const adoptedReads = [];
  for (const [method, params] of [["DOM.getAttributes", { nodeId: tplNode }], ["DOM.getOuterHTML", { nodeId: tplNode }], ["DOM.getBoxModel", { nodeId: tplNode }], ["DOM.describeNode", { nodeId: tplNode }], ["Accessibility.getPartialAXTree", { nodeId: tplNode }], ["Accessibility.queryAXTree", { nodeId: tplNode }]]) {
    adoptedReads.push([method, await plugin.send(method, params, ps)]);
  }
  check("plugin: a template node it mapped stays mapped when the page adopts the template into a window-2 document, and every read and scroll by that nodeId is refused as not in this page", !!tplNode && /tplp/.test(beforeAdoption.result?.outerHTML ?? "") && adopted === true && adoptedReads.every(([, r]) => /that nodeId isn't in this page/.test(r.error?.message ?? "")), `before: ${text(beforeAdoption)}; ` + adoptedReads.map(([m, r]) => `${m}: ${text(r)}`).join(" | "));
  await cli.send("Runtime.evaluate", { expression: "(() => { const s = document.createElement('section'); s.id = 'axroot'; s.innerHTML = '<button>ax</button>'; document.body.append(s); return true })()" }, csOne);
  const axRoot = (await plugin.send("DOM.querySelector", { nodeId: await pluginRoot(), selector: "#axroot" }, ps)).result?.nodeId;
  await cli.send("Debugger.enable", {}, csOne);
  const pauseMark = cli.events.length;
  cli.raw(556001, "Runtime.evaluate", { expression: "debugger; popupRef.document.body.append(popupRef.document.adoptNode(document.getElementById('axroot'))); true", returnByValue: true }, csOne);
  const paused = await until("the debugger pause", async () => cli.events.slice(pauseMark).some((e) => e.method === "Debugger.paused") || null, 8000).catch(() => false);
  const queryMark = plugin.replies.length;
  plugin.raw(556002, "Accessibility.queryAXTree", { nodeId: axRoot, role: "button" }, ps);
  const queued = await plugin.send("DOM.describeNode", { nodeId: axRoot }, ps);
  const answeredWhileQueued = plugin.replies.slice(queryMark).some((m) => m.id === 556002);
  await cli.send("Debugger.resume", {}, csOne);
  const adoption = (await cli.repliesTo(556001, 0, 2000))[0];
  const pending = (await plugin.repliesTo(556002, queryMark, 3000))[0];
  await cli.send("Debugger.disable", {}, csOne);
  check("plugin: a queryAXTree queued while its root moved to a window-2 document is refused when it resumes", !!axRoot && paused === true && !refused(queued) && !answeredWhileQueued && adoption?.result?.result?.value === true && /left this page while the query was pending/.test(pending?.error?.message ?? ""), `paused ${paused}, queued ${text(queued)}, answered early ${answeredWhileQueued}, adoption ${adoption ? text(adoption) : "no reply"}, ${pending ? text(pending) : "no reply"}`);

  const folder = join(work, "picked");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.txt"), "from the ardia command");
  writeFileSync(join(folder, "b.txt"), "b");
  const cs = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  const click = async (id) => {
    await cli.send("Runtime.evaluate", { expression: "window.picked = null" }, cs);
    const box = (await cli.send("Runtime.evaluate", { expression: `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`, returnByValue: true }, cs)).result?.result?.value ?? [0, 0];
    for (const type of ["mousePressed", "mouseReleased"]) await cli.send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cs);
    return until(`the ${id} picker`, async () => (await cli.send("Runtime.evaluate", { expression: "window.picked", returnByValue: true }, cs)).result?.result?.value ?? null, 15000).catch((e) => String(e.message));
  };
  const arm = (kind, paths) => cli.send("Ardia.answerFilePicker", { kind, paths }, cs);
  const armedOpen = await arm("open", [join(folder, "a.txt")]);
  check("cli: Ardia.answerFilePicker arms an answer", !refused(armedOpen), text(armedOpen));
  check("cli: showOpenFilePicker takes the answered file", (await click("open")) === "open:a.txt:from the ardia command");
  await arm("save", [join(folder, "out.txt")]);
  const saved = await click("save");
  check("cli: showSaveFilePicker takes the answered path and the page writes it", saved === "save:out.txt" && existsSync(join(folder, "out.txt")) && readFileSync(join(folder, "out.txt"), "utf8") === "saved by the page", saved);
  await arm("directory", [folder]);
  const listed = await click("dir");
  check("cli: showDirectoryPicker takes the answered folder without a permission prompt", listed === "dir:a.txt,b.txt,out.txt", listed);
  const readwrite = await cli.send("Runtime.evaluate", { expression: "Promise.race([window.dirHandle.queryPermission({ mode: 'read' }).then((read) => window.dirHandle.queryPermission({ mode: 'readwrite' }).then((write) => read + '/' + write))])", awaitPromise: true, returnByValue: true }, cs);
  check("cli: a read-only directory answer leaves the folder granted for reading and not for writing", !refused(readwrite) && !readwrite.result?.exceptionDetails && readwrite.result?.result?.value === "granted/prompt", text(readwrite));
  await arm("open", []);
  check("cli: an empty answer cancels the picker", (await click("open")) === "error:AbortError");
  const wrongKind = await arm("save", [join(folder, "x.txt")]);
  const unanswered = await click("open").then((v) => v, () => null);
  check("cli: an answer of another kind leaves the picker alone", !refused(wrongKind) && unanswered !== "open:x.txt", String(unanswered));

  await arm("open", [join(folder, "a.txt")]);
  await cli.send("Page.reload", {}, cs);
  await until("page one reloaded", async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete' && !!document.getElementById('open')", returnByValue: true }, cs)).result?.result?.value);
  const afterNavigation = await click("open").then((v) => v, () => null);
  const reloadedTotals = await leaseTotals();
  const afterReload = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 7, y: 7 }, ps);
  check("lease: a new document ends the lease, so the plugin's next input is refused", noLease(afterReload) && reloadedTotals.endedByDocument > 0, `${text(afterReload)} ${JSON.stringify(reloadedTotals)}`);
  check("cli: an answer armed before a navigation isn't used by the new document", afterNavigation !== "open:a.txt:from the ardia command", String(afterNavigation));
  const duplicateMark = cli.replies.length;
  cli.raw(424242, "Runtime.evaluate", { expression: "new Promise((r) => setTimeout(() => r(1), 1500))", awaitPromise: true }, cs);
  cli.raw(424242, "Ardia.answerFilePicker", { kind: "open", paths: [join(folder, "a.txt")] }, cs);
  const duplicates = await cli.repliesTo(424242, duplicateMark, 3000);
  check("cli: Ardia.answerFilePicker with a pending command's id is refused and the first command still answers",
    duplicates.length === 2 && duplicates.some((m) => /still waiting/.test(m.error?.message ?? "")) && duplicates.some((m) => m.result?.result?.value === 1),
    JSON.stringify(duplicates).slice(0, 300));

  const threeTarget = (await urlsOf(plugin)).find((t) => t.url === `${origin}/three`);
  const s3 = (await plugin.send("Target.attachToTarget", { targetId: threeTarget?.targetId, flatten: true })).result?.sessionId;
  const schemes = [[`${origin}/three`, true], ["about:blank", true], [`${secureOrigin}/secure`, true], ["javascript:void 0", false], ["data:text/html,x", false], [`blob:${origin}/x`, false], ["file:///etc/hosts", false], ["chrome://version", false], [`view-source:${origin}/three`, false], [`filesystem:${origin}/temporary/x`, false], ["ftp://127.0.0.1/x", false], ["ardia://settings", false]];
  for (const [url, allowedScheme] of schemes) {
    const reply = await leasedSend("t3", "Page.navigate", { url }, s3);
    const refusedByPolicy = refused(reply) && /isn't allowed for a plugin/.test(reply.error?.message ?? "");
    check(`plugin: Page.navigate to ${url.split(":")[0]}: is ${allowedScheme ? "allowed and loads" : "refused"}`, allowedScheme ? !refused(reply) && !reply.result?.errorText && !!reply.result?.frameId : refusedByPolicy, text(reply));
    if (url.startsWith(secureOrigin)) {
      let committed = null, content = null;
      const loaded = await until("the secure fixture's URL and content", async () => {
        committed = (await plugin.send("Page.getFrameTree", {}, s3)).result?.frameTree?.frame?.url;
        const root = (await plugin.send("DOM.getDocument", {}, s3)).result?.root?.nodeId;
        const node = root && (await plugin.send("DOM.querySelector", { nodeId: root, selector: "#secure" }, s3)).result?.nodeId;
        content = node ? (await plugin.send("DOM.getOuterHTML", { nodeId: node }, s3)).result?.outerHTML : null;
        return committed === `${secureOrigin}/secure` && /ardia secure fixture/.test(content ?? "") || null;
      }, 8000).then(() => true, () => false);
      check("plugin: the HTTPS navigation committed exactly the fixture's URL and shows its content", loaded, `${committed} ${content}`);
    }
  }
  const navigatedPlain = await leasedSend("t3", "Page.navigate", { url: `${origin}/three` }, s3);
  check("plugin: Page.navigate with only a web url answers", !refused(navigatedPlain), text(navigatedPlain));
  const pageVisibility = async (session) => {
    const root = (await plugin.send("DOM.getDocument", {}, session)).result?.root?.nodeId;
    const body = root && (await plugin.send("DOM.querySelector", { nodeId: root, selector: "body" }, session)).result?.nodeId;
    const attributes = body ? (await plugin.send("DOM.getAttributes", { nodeId: body }, session)).result?.attributes ?? [] : [];
    const at = attributes.indexOf("data-visibility");
    return at >= 0 ? attributes[at + 1] : null;
  };
  const visibilityIs = (session, state) => until(`the page to report ${state}`, async () => (await pageVisibility(session)) === state || null, 8000).then(() => true, () => false);
  if (heldLeases.has("t3")) {
    await releaseLease(heldLeases.get("t3"));
    heldLeases.delete("t3");
  }
  const hiddenBefore = await visibilityIs(s3, "hidden");
  const outsideWheel = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 50, y: 50, deltaX: 0, deltaY: 20 }, s3);
  const actLease = await leaseOf("t3");
  const visibleDuring = await visibilityIs(s3, "visible");
  const actWheel = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 50, y: 50, deltaX: 0, deltaY: 20 }, s3);
  const released = await releaseLease(actLease?.lease);
  const hiddenAfter = await visibilityIs(s3, "hidden");
  check("lease: a background tab reports visible only while the AI acts on it (the lease turns the engine's visible hold on before it grants and off once it ends and its last action returned), and a wheel outside an act is refused",
    hiddenBefore && refused(outsideWheel) && (outsideWheel.error?.message === LEASE_MISSING || outsideWheel.error?.message === "ardia: page hidden") && typeof actLease?.lease === "number" && visibleDuring && !refused(actWheel) && released?.released === true && hiddenAfter,
    `before ${hiddenBefore} | ${text(outsideWheel)} | lease ${JSON.stringify(actLease)} during ${visibleDuring} | ${text(actWheel)} | ${JSON.stringify(released)} after ${hiddenAfter}`);
  const cs3 = (await cli.send("Target.attachToTarget", { targetId: threeTarget?.targetId, flatten: true })).result?.sessionId;
  await until("page three loaded", async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, cs3)).result?.result?.value);
  await cli.send("Runtime.evaluate", { expression: "window.moves = 0; window.wheels = 0; addEventListener('mousemove', () => window.moves++); addEventListener('wheel', () => window.wheels++, { passive: true }); true" }, cs3);
  const moves = async () => (await cli.send("Runtime.evaluate", { expression: "window.moves", returnByValue: true }, cs3)).result?.result?.value;
  const wheels = async () => (await cli.send("Runtime.evaluate", { expression: "window.wheels", returnByValue: true }, cs3)).result?.result?.value;
  const inWindow = (tab, win) => until(`${tab} in ${win}`, async () =>
    ((await appEval(`return ac.engine.call("tabs.strips")`))?.strips ?? []).some((s) => s.appWindow === win && s.tabs.some((t) => t.key === tab)) || null, 8000).then(() => true, () => false);
  await holdTab("t3");
  const departedRefusals = async () => (await appEval(`return ac.engine.call("engine.cliControlStatus")`))?.pluginDeliveriesRefusedDeparted ?? -1;
  const refusalsBefore = await departedRefusals();
  for (let i = 0; i < 20; i++) plugin.raw(660000 + i, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10 + i * 5, y: 10 + i * 3 }, s3);
  for (let i = 0; i < 5; i++) plugin.raw(661000 + i, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 50, y: 50, deltaX: 0, deltaY: 20 }, s3);
  const threeClicksBefore = await csValue(cs3, "window.clicks");
  const [threeClickX, threeClickY] = await centerOf(cs3, "clicker");
  plugin.raw(662000, "Ardia.dispatchClick", { x: threeClickX, y: threeClickY }, s3);
  const sentAt = Date.now();
  const leaseBeforeMove = heldLeases.get("t3");
  const detachBeforeMove = (await leaseTotals()).endedByDetach ?? 0;
  await appEval(`ac.actions.moveTabToWindow("t3", "w2"); return true`);
  const reachedOther = await inWindow("t3", "w2");
  const movesAtDeparture = await moves();
  await appEval(`ac.actions.moveTabToWindow("t3", "w1"); return true`);
  const cameBack = await inWindow("t3", "w1");
  const backBeforeDelivery = Date.now() - sentAt < 1800;
  await sleep(2500);
  const movesAfterReturn = await moves();
  const wheelsAfterReturn = await wheels();
  const refusalsAfter = await departedRefusals();
  const outAndBack = await plugin.send("DOM.getDocument", {}, s3);
  const detachedS3 = await until("the detach of the moved session", async () => plugin.events.some((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === s3) || null, 10000).catch(() => false);
  check("plugin: a tab moved to the other window (confirmed natively) and back stays detached", reachedOther && cameBack && !!s3 && refused(outAndBack) && detachedS3, `reached w2 ${reachedOther}, back in w1 ${cameBack}, ${text(outAndBack)}`);
  const departedBusy = plugin.replies.filter((m) => m.id > 661000 && m.id < 661005 && m.error?.message === "ardia: busy").length;
  check("plugin: of five back-to-back wheels from the departing session, the four behind the first answer ardia: busy at once (one outstanding wheel per credential and tab)", departedBusy === 4, `busy ${departedBusy}`);
  check("plugin: mouse, wheel and an Ardia.dispatchClick its departed session queued reached the gate after hit testing, after the tab came back, and the gate refused them for the old session, at most 22 (20 moves, one wheel, one click; the click never landed)", backBeforeDelivery && refusalsBefore >= 0 && refusalsAfter - refusalsBefore > 0 && refusalsAfter - refusalsBefore <= 22 && (await csValue(cs3, "window.clicks")) === threeClicksBefore && movesAtDeparture === 0 && movesAfterReturn === 0 && wheelsAfterReturn === 0, `back before delivery ${backBeforeDelivery}, gate refusals ${refusalsBefore} -> ${refusalsAfter}, moves ${movesAtDeparture}/${movesAfterReturn}, wheels ${wheelsAfterReturn}`);
  const departedTotals = await leaseTotals();
  const departedRelease = await releaseLease(leaseBeforeMove);
  heldLeases.delete("t3");
  check("lease: a tab leaving its window ends the credential's lease on it at once, so a tab that comes back needs a new grant",
    typeof leaseBeforeMove === "number" && departedTotals.endedByDetach > detachBeforeMove && departedRelease?.released === false,
    `${leaseBeforeMove} ${JSON.stringify(departedTotals)} ${JSON.stringify(departedRelease)}`);
  const old = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 20 }, s3);
  const fresh = (await plugin.send("Target.attachToTarget", { targetId: threeTarget?.targetId, flatten: true })).result?.sessionId;
  await holdTab("t3");
  const freshMove = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 30, y: 30 }, fresh);
  const freshWheel = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 30, y: 30, deltaX: 0, deltaY: 20 }, fresh);
  const hasFocus = () => csValue(cs3, "document.hasFocus()");
  const freshKey = await plugin.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 }, fresh);
  await plugin.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }, fresh);
  const freshText = await plugin.send("Input.insertText", { text: "zz" }, fresh);
  const focusAfterPointer = await hasFocus();
  check("plugin: its buttonless moves, wheels, keys and insertText on a background page don't focus it", focusAfterPointer === false && !refused(freshMove) && !refused(freshWheel) && !refused(freshKey) && !refused(freshText), `hasFocus ${focusAfterPointer}`);
  const freshClicksBefore = await csValue(cs3, "window.clicks");
  const freshClick = await plugin.send("Ardia.dispatchClick", { x: threeClickX, y: threeClickY }, fresh);
  await sleep(300);
  const freshClicked = (await csValue(cs3, "window.clicks")) === freshClicksBefore + 1;
  const freshMoves = await moves();
  const freshWheels = await wheels();
  check("plugin: the departed session's input is refused, and a fresh attach to the returned tab delivers a mouse move, a wheel event and a click", refused(old) && !!fresh && !refused(freshMove) && !refused(freshWheel) && !refused(freshClick) && freshClicked && freshMoves > movesAfterReturn && freshWheels > wheelsAfterReturn, `${text(old)} ${text(freshMove)} ${text(freshWheel)} moves ${freshMoves} wheels ${freshWheels}`);
  const heldMark = plugin.replies.length;
  plugin.raw(663000, "Ardia.dispatchClick", { x: threeClickX, y: threeClickY }, fresh);
  plugin.raw(663001, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 30, y: 30, deltaX: 0, deltaY: 20 }, fresh);
  await cli.send("Page.navigate", { url: `${origin}/three` }, cs3);
  await until("page three reloaded", async () => (await csValue(cs3, "document.readyState === 'complete' && window.clicks === 0")) || null, 8000).catch(() => null);
  const heldReply = (await plugin.repliesTo(663000, heldMark, 3500))[0];
  const heldWheel = (await plugin.repliesTo(663001, heldMark, 100))[0];
  const clicksAfterNavigation = await csValue(cs3, "window.clicks");
  check("plugin: a click held past an in-scope navigation is refused at delivery and never lands in the new document", !!heldReply && refused(heldReply) && /page changed/.test(heldReply.error?.message ?? "") && clicksAfterNavigation === 0, `${heldReply ? text(heldReply) : "no reply"} clicks ${clicksAfterNavigation}`);
  check("plugin: a wheel held past an in-scope navigation is refused at delivery", !!heldWheel && refused(heldWheel) && /page changed/.test(heldWheel.error?.message ?? ""), heldWheel ? text(heldWheel) : "no reply");

  const t3Target = (await urlsOf(cli)).find((t) => t.url === `${origin}/three`);
  const direct = await connect(`ws://127.0.0.1:${control.port}/devtools/page/${t3Target?.targetId}?token=${encodeURIComponent(minted.credential)}`).catch(() => null);
  const directOrder = [];
  if (direct) {
    direct.ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id === 888001) directOrder.push(`reply:${m.error?.message ?? "result"}`); });
    direct.closed.then(() => directOrder.push("close"));
    direct.ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id === 888002) directOrder.push(`concurrent:${m.error?.message ?? "result"}`); });
    await holdTab("t3");
    for (let i = 0; i < 20; i++) direct.raw(889000 + i, "Page.getLayoutMetrics", {});
    const requestedBefore = requested.length;
    direct.raw(888001, "Page.navigate", { url: `${origin}/slow-three` });
    await until("the fixture server to receive /slow-three", async () => requested.slice(requestedBefore).includes("/slow-three") || null, 5000).catch(() => null);
    await appEval(`ac.actions.moveTabToWindow("t3", "w2"); return true`);
    direct.raw(888002, "Page.getLayoutMetrics", {});
    await until("the direct socket to close", async () => directOrder.includes("close") || null, 8000).catch(() => null);
  }
  check("plugin: a direct page socket gets tab_out_of_scope for its command in flight before it closes", (directOrder[0] ?? "").startsWith("reply:ardia: tab_out_of_scope") && directOrder.at(-1) === "close", directOrder.join(" | ") || "no direct socket");
  check("plugin: under a backlog, a command sent during the scope close gets tab_out_of_scope before the close", directOrder.some((e) => e.startsWith("concurrent:ardia: tab_out_of_scope")) && directOrder.indexOf("close") > directOrder.findIndex((e) => e.startsWith("concurrent:")), directOrder.join(" | ") || "no direct socket");
  await appEval(`ac.actions.moveTabToWindow("t3", "w1"); return true`);
  await inWindow("t3", "w1");

  await holdTab("t1");
  const lateMark = plugin.replies.length;
  plugin.raw(777001, "Page.navigate", { url: `${origin}/slow-one` }, ps);
  await appEval(`ac.actions.moveTabToWindow("t1", "w2"); return true`);
  const late = await plugin.repliesTo(777001, lateMark, 4000);
  const returned = await appEval(`const t = Object.values(ac.store.getState().tabs).find((x) => x?.url?.endsWith("/four")); if (t) ac.actions.moveTabToWindow(t.id, "w1"); return !!t`);
  await sleep(1500);
  const orphan = (await plugin.send("Target.getTargets")).result?.targetInfos?.find((t) => t.url === `${origin}/four`);
  check("plugin: a target whose opener left its window shows no opener", returned === true && !!orphan && !orphan.openerId && !orphan.openerFrameId && orphan.canAccessOpener !== true, JSON.stringify(orphan ?? null).slice(0, 300));
  check("plugin: a reply that finishes after its tab moved never reaches it; it gets exactly one tab_out_of_scope error",
    late.length === 1 && (late[0].error?.message ?? "").startsWith("ardia: tab_out_of_scope") && !late.some((m) => m.result), JSON.stringify(late).slice(0, 300));
  const detached = await until("the detach event", async () => plugin.events.find((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === ps) ?? null, 12000).catch(() => null);
  check("plugin: its session on the moved tab is detached with Target.detachedFromTarget", !!detached);
  const afterMove = await plugin.send("DOM.getDocument", {}, ps);
  check("plugin: the moved tab's session takes no more commands", refused(afterMove), text(afterMove));
  const seenAfterMove = (await urlsOf(plugin)).map((t) => t.url);
  check("plugin: Target.getTargets no longer lists the moved tab", !seenAfterMove.includes(`${origin}/one`), seenAfterMove.join(" "));

  const cliCookies = await cli.send("Network.getCookies", {}, cliTwo.result?.sessionId);
  check("cli: still gets everything after a plugin connected (Network.getCookies)", !refused(cliCookies), text(cliCookies));

  const drained = orphan && (await connect(`ws://127.0.0.1:${control.port}/devtools/page/${orphan.targetId}?token=${encodeURIComponent(minted.credential)}`).catch(() => null));
  let drainedReplies = 0;
  let drainedClosedAt = 0;
  if (drained) {
    drained.ws.addEventListener("message", () => drainedReplies++);
    drained.closed.then(() => (drainedClosedAt = Date.now()));
    for (let i = 0; i < 20; i++) drained.raw(890000 + i, "Page.getLayoutMetrics", {});
    await appEval(`const t = Object.values(ac.store.getState().tabs).find((x) => x?.url?.endsWith("/four")); if (t) ac.actions.moveTabToWindow(t.id, "w2"); return !!t`);
  }
  const pluginAlive = await plugin.send("Target.getTargets");
  check("plugin: its browser connection stays open after the detach", !refused(pluginAlive), text(pluginAlive));
  const revokeStarted = Date.now();
  const revoked = await appEval(`return ac.engine.call("engine.cliPluginCredential", { revoke: ${JSON.stringify(minted.id)} })`);
  const closedInTime = await Promise.race([plugin.closed.then(() => true), sleep(5000).then(() => false)]);
  check("revoking the credential closes its connection", revoked?.revoked === true && closedInTime, JSON.stringify(revoked));
  const holdsAfterRevoke = await until("the holds to drop on revoke", async () => ((await tabHolds()) === 0 ? "none" : null), 5000).catch(() => null);
  check("plugin: the revoke drops every hold the credential had", holdsAfterRevoke === "none", String(await tabHolds()));
  const cliVis = (await cli.send("Target.attachToTarget", { targetId: visTarget.targetId, flatten: true })).result?.sessionId;
  const cliVisState = cliVis && (await until("the owner's hold", async () => ((await cli.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, cliVis)).result?.result?.value === "visible" ? "visible" : null), 5000).catch(() => null));
  check("cli: the owner token still makes a background tab visible when it attaches", cliVisState === "visible", String(cliVisState));
  const revokedTotals = await leaseTotals();
  check("lease: revoking the credential leaves none of its leases live", revokedTotals.live === 0, JSON.stringify(revokedTotals));
  await until("the draining socket to close", async () => drainedClosedAt || null, 4000).catch(() => null);
  check("plugin: a revoke during a scope close closes the draining socket at once", !!drained && drainedClosedAt > 0 && drainedClosedAt - revokeStarted < 2000 && drainedReplies <= 20, drained ? `closed after ${drainedClosedAt ? drainedClosedAt - revokeStarted : "never"} ms, ${drainedReplies} replies` : "no socket");
  const again = await connect(`${base}?token=${encodeURIComponent(minted.credential)}`).then(() => "accepted", () => "refused");
  check("a revoked credential can't connect again", again === "refused", again);
  const cliAlive = await cli.send("Browser.getVersion");
  check("cli: its connection is untouched by the revoke", !refused(cliAlive), text(cliAlive));

  const tabTarget = async (tabId) => (await appEval(`return ac.engine.call("engine.cliTabTargets", { tabIds: [${JSON.stringify(tabId)}] })`))?.[tabId]?.targetId ?? null;
  const loaded = (session, what) => until(what, async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, session)).result?.result?.value || null, 15000).then(() => true, () => false);
  const later = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t3" })`);
  const laterPlugin = await connect(`${base}?token=${encodeURIComponent(later.credential)}`);
  const threeId = await tabTarget("t3");
  let lp3 = (await laterPlugin.send("Target.attachToTarget", { targetId: threeId, flatten: true })).result?.sessionId;
  const lc3 = (await cli.send("Target.attachToTarget", { targetId: threeId, flatten: true })).result?.sessionId;
  await cli.send("Page.enable", {}, lc3);
  await cli.send("Page.navigate", { url: `${origin}/bf-one` }, lc3);
  await loaded(lc3, "bf-one");
  const bfLease = await leaseOf("t3", later.id);
  await cli.send("Runtime.evaluate", { expression: "window.bfMarker = 1" }, lc3);
  await cli.send("Page.navigate", { url: `${origin}/bf-two` }, lc3);
  await loaded(lc3, "bf-two");
  const history = (await cli.send("Page.getNavigationHistory", {}, lc3)).result;
  const back = history?.entries?.[history.currentIndex - 1];
  if (back) await cli.send("Page.navigateToHistoryEntry", { entryId: back.id }, lc3);
  await until("bf-one back", async () => (await cli.send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true }, lc3)).result?.result?.value === "/bf-one" || null, 15000).catch(() => null);
  const restored = (await cli.send("Runtime.evaluate", { expression: "window.bfMarker === 1", returnByValue: true }, lc3)).result?.result?.value === true;
  const afterBack = await laterPlugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 }, lp3);
  const bfRelease = await releaseLease(bfLease?.lease);
  check("lease: a lease ends when its tab navigates away and stays ended when the page comes back from the back-forward cache", restored && typeof bfLease?.lease === "number" && noLease(afterBack) && bfRelease?.released === false, `restored from the back-forward cache: ${restored}; ${text(afterBack)} ${JSON.stringify(bfRelease)}`);

  const approvedDocument = await documentOf("t3", later.id);
  await cli.send("Page.navigate", { url: `${origin}/replaced` }, lc3);
  await loaded(lc3, "replaced");
  const replacedLease = await leaseFor("t3", approvedDocument?.document, later.id);
  const currentDocument = await documentOf("t3", later.id);
  const currentLease = await leaseFor("t3", currentDocument?.document, later.id);
  await releaseLease(currentLease?.lease);
  check("lease: a grant names the document approved on the card, so a tab that loaded a replacement document since is refused (document_changed) before its hold is taken, and the current document leases",
    typeof approvedDocument?.document === "number" && typeof replacedLease?.lease !== "number" && (replacedLease?.error ?? "").includes("ardia: document_changed: the tab loaded a new document since the act was approved") && currentDocument?.document !== approvedDocument?.document && typeof currentLease?.lease === "number",
    `${JSON.stringify(approvedDocument)} ${JSON.stringify(replacedLease)} ${JSON.stringify(currentDocument)} ${JSON.stringify(currentLease)}`);
  const detachLease = await leaseOf("t3", later.id);
  const beforeDetach = await leaseTotals();
  const detachReply = await laterPlugin.send("Target.detachFromTarget", { sessionId: lp3 });
  const endedByDetach = await until("the detach to end the lease", async () => ((await leaseTotals()).endedByDetach > (beforeDetach.endedByDetach ?? 0)) || null, 8000).then(() => true, () => false);
  lp3 = (await laterPlugin.send("Target.attachToTarget", { targetId: threeId, flatten: true })).result?.sessionId;
  const afterReattach = await laterPlugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 6 }, lp3);
  const oldDetachRelease = await releaseLease(detachLease?.lease);
  const regrant = await leaseOf("t3", later.id);
  const afterRegrant = await laterPlugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 7, y: 7 }, lp3);
  await releaseLease(regrant?.lease);
  check("lease: when a credential's last session on a tab detaches, its lease there ends; a fresh attach is refused until a new grant, then acts",
    typeof detachLease?.lease === "number" && !refused(detachReply) && endedByDetach && !!lp3 && noLease(afterReattach) && oldDetachRelease?.released === false && typeof regrant?.lease === "number" && !refused(afterRegrant),
    `${text(detachReply)} ended ${endedByDetach} | ${text(afterReattach)} | old ${JSON.stringify(oldDetachRelease)} | new ${JSON.stringify(regrant)} ${text(afterRegrant)}`);

  await cli.send("Runtime.evaluate", { expression: `(() => { const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = JSON.stringify({ prerender: [{ source: "list", urls: ["/prerendered"] }] }); document.head.append(s); return true })()` }, lc3);
  const prerendered = await until("a prerender target", async () => (await cli.send("Target.getTargets")).result?.targetInfos?.find((t) => t.url === `${origin}/prerendered`) ?? null, 15000).catch(() => null);
  const primaryLease = await leaseOf("t3", later.id);
  const prerenderAttach = prerendered && (await laterPlugin.send("Target.attachToTarget", { targetId: prerendered.targetId, flatten: true }));
  const prerenderSession = prerenderAttach?.result?.sessionId;
  const prerenderActs = prerenderSession ? [
    await laterPlugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 }, prerenderSession),
    await laterPlugin.send("Ardia.dispatchClick", { x: 4, y: 4 }, prerenderSession),
    await laterPlugin.send("Page.reload", {}, prerenderSession),
  ] : [];
  const primaryAct = await laterPlugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, lp3);
  check("lease: a prerendered page of a leased tab never acts under the primary page's lease (it can't attach, or every act is refused)",
    !!prerendered && typeof primaryLease?.lease === "number" && !refused(primaryAct) && (!prerenderSession || prerenderActs.every(noLease)),
    `${prerendered ? prerendered.type + "/" + (prerendered.subtype ?? "") : "no prerender target"} attach ${prerenderAttach ? text(prerenderAttach) : "-"} ${prerenderActs.map(text).join(" | ")} primary ${text(primaryAct)}`);
  await releaseLease(primaryLease?.lease);

  const crashTarget = await tabTarget("t2");
  const crashCredential = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t2" })`);
  const crashPlugin = await connect(`${base}?token=${encodeURIComponent(crashCredential.credential)}`);
  const c2 = (await crashPlugin.send("Target.attachToTarget", { targetId: crashTarget, flatten: true })).result?.sessionId;
  const crashLease = await leaseOf("t2", crashCredential?.id);
  const crashBefore = await leaseTotals();
  await pointerTest({ park: true });
  crashPlugin.raw(660100, "Ardia.dispatchClick", { x: 20, y: 20 }, c2);
  const staleParked = await parkedNow(1);
  await pointerTest({ park: false });
  const lc2 = crashTarget && (await cli.send("Target.attachToTarget", { targetId: crashTarget, flatten: true })).result?.sessionId;
  if (lc2) cli.raw(990001, "Page.crash", {}, lc2);
  const crashEnded = await until("the renderer exit to end the lease", async () => ((await leaseTotals()).endedByDocument > crashBefore.endedByDocument) || null, 10000).then(() => true, () => false);
  const crashRelease = await releaseLease(crashLease?.lease);
  if (lc2) await cli.send("Page.reload", {}, lc2);
  await until("the crashed tab to load again", async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, lc2)).result?.result?.value || null, 15000).catch(() => null);
  const reuseLease = await leaseOf("t2", crashCredential?.id);
  const reuseMark = crashPlugin.replies.length;
  crashPlugin.raw(660100, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 }, c2);
  const staleReleased = await pointerTest({ release: true });
  const reuseReply = await replyTo(crashPlugin, reuseMark, 660100, 8000);
  await sleep(1000);
  const reuseReplies = crashPlugin.replies.slice(reuseMark).filter((m) => m.id === 660100);
  await releaseLease(reuseLease?.lease);
  check("plugin: after a renderer crash cleared its pending click, a new command reusing that id gets exactly its own reply, and the stale click's late completion settles nothing",
    !!c2 && staleParked && typeof reuseLease?.lease === "number" && staleReleased?.released === 1 && reuseReply && !refused(reuseReply) && reuseReplies.length === 1,
    `${JSON.stringify(reuseLease)} ${JSON.stringify(staleReleased)} ${reuseReplies.map(text).join(" | ")}`);
  check("lease: a renderer exit ends the tab's lease", typeof crashLease?.lease === "number" && crashEnded && crashRelease?.released === false, `${JSON.stringify(crashLease)} ${JSON.stringify(crashRelease)}`);
  crashPlugin.ws.close();
  await appEval(`return ac.engine.call("engine.cliPluginCredential", { revoke: ${JSON.stringify(crashCredential?.id)} })`);

  const restartLease = await leaseOf("t3", later.id);
  await appEval(`return ac.engine.call("engine.setCliControl", { on: false })`);
  await appEval(`return ac.engine.call("engine.setCliControl", { on: true })`);
  const restarted = await until("the control server to come back", async () => (await appEval(`return ac.engine.call("engine.cliControlStatus")`))?.state === "on" || null, 15000).then(() => true, () => false);
  const restartTotals = await leaseTotals();
  const oldRelease = await releaseLease(restartLease?.lease);
  const remint = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t3" })`);
  const remintPlugin = remint?.endpoint ? await connect(`${remint.endpoint}?token=${encodeURIComponent(remint.credential)}`).catch(() => null) : null;
  if (remintPlugin) await remintPlugin.send("Target.attachToTarget", { targetId: threeId, flatten: true });
  const afterRestart = await leaseOf("t3", remint?.id);
  check("lease: after the control server restarts no lease survives, an old id releases nothing, and new ids keep counting",
    typeof restartLease?.lease === "number" && restarted && restartTotals.live === 0 && oldRelease?.released === false && afterRestart?.lease > restartLease.lease,
    `${JSON.stringify(restartLease)} ${JSON.stringify(restartTotals)} ${JSON.stringify(oldRelease)} ${JSON.stringify(afterRestart)}`);
  await releaseLease(afterRestart?.lease);
  remintPlugin?.ws.close();
  await appEval(`return ac.engine.call("engine.cliPluginCredential", { revoke: ${JSON.stringify(remint?.id)} })`);
  cli.ws.close();
} finally {
  answerHanging();
  server.close();
  secure.close();
  rmSync(certDir, { recursive: true, force: true });
  if (pid) try { process.kill(pid); } catch {}
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
