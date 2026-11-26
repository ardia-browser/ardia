#!/usr/bin/env node
const usage = `engine-cli-check.mjs <Ardia.app> [metro host:port] [scratch dir]

Launches a hidden Ardia with control on and no DevTools port, and drives it only through ArdiaControl.sock to check the
engine's tab primitives (#4055): devtools.attach/send/batch/detach with pushed events, tabs.snapshot (refs across a
cross-site iframe and a closed shadow root, boxes that match the page's own geometry, covered elements, modal scope),
tabs.waitSettled over a delayed fetch, tabs.hitTest and tabs.click (blocked by a cookie banner, its dismiss button,
then the click landing, inside the cross-site iframe too, and a far element scrolled into view), a stale ref rebound
after the page re-renders it, and tabs.screenshot and Page.captureScreenshot of a tab that isn't on screen. Every
shared hostile input is sent as each new method's params and must be refused. A Debug build needs its Metro as the
second argument. The run uses a new folder inside the scratch dir and removes only that folder.`;

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { isAlive, session } from "../../../scripts/lib/instance.mjs";
import { HOSTILE_STRINGS, HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const [appArg, metroArg, scratchArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
const scratch = resolve(scratchArg ?? process.env.TMPDIR ?? "/tmp");
fs.mkdirSync(scratch, { recursive: true });
const work = fs.mkdtempSync(join(scratch, "ac-engine-cli-"));
const data = join(work, "d");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(join(data, "session.json"), JSON.stringify(session({ settings: { cliControl: true } })));
fs.writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail).slice(0, 700)})`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port = 0;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>body{font:16px sans-serif;margin:0;padding:20px}</style></head><body>${body}</body></html>`;
const pages = {
  "/main": () =>
    page(`<h1>Main page</h1>
<button id="save" style="position:absolute;left:40px;top:300px;width:120px;height:40px" onclick="document.title='saved'">Save</button>
<div id="host" style="position:absolute;left:300px;top:120px"></div>
<iframe id="f" src="http://127.0.0.1:${port}/frame" style="position:absolute;left:40px;top:120px;width:220px;height:120px;border:0"></iframe>
<div id="banner" style="position:fixed;left:0;right:0;top:260px;height:140px;background:#eee;z-index:10"><p>We use cookies</p><button onclick="document.getElementById('banner').remove()">Reject all</button> <button onclick="document.getElementById('banner').remove()">Accept all</button></div>
<script>
const root = document.getElementById('host').attachShadow({mode:'closed'});
root.innerHTML = '<button id="sh">Shadow action</button>';
root.getElementById('sh').onclick = () => { document.title = 'shadow'; };
addEventListener('message', (e) => { if (e.data === 'frame-click') document.title = 'frame'; });
window.rerender = () => { const b = document.getElementById('save'); const c = b.cloneNode(true); b.replaceWith(c); };
</script>`),
  "/scaled": () =>
    page(`<iframe src="http://127.0.0.1:${port}/outer" style="position:absolute;left:40px;top:120px;width:200px;height:120px;border:0;transform:scale(2);transform-origin:0 0"></iframe>
<script>addEventListener('message', (e) => { if (e.data === 'deep-click') document.title = 'deep'; });</script>`),
  "/outer": () => page(`<iframe src="/inner" style="position:absolute;left:10px;top:10px;width:150px;height:80px;border:0"></iframe>`),
  "/inner": () => page(`<button style="position:absolute;left:10px;top:10px;width:80px;height:30px" onclick="top.postMessage('deep-click','*')">Deep</button>`),
  "/vanish": () =>
    page(`<button style="position:absolute;left:40px;top:120px;width:200px;height:80px" onclick="window.under++">Under</button>
<iframe id="vf" src="/vanish-frame" style="position:absolute;left:40px;top:120px;width:200px;height:80px;border:0;background:#fff"></iframe>
<script>window.hits = 0; window.under = 0;</script>`),
  "/vanish-frame": () =>
    page(`<button style="position:absolute;left:0;top:0;width:200px;height:80px" onclick="parent.hits++; parent.document.getElementById('vf').remove()">Vanish</button>`),
  "/frame": () => page(`<button id="fb" style="width:150px;height:40px" onclick="parent.postMessage('frame-click','*')">Frame button</button>`),
  "/slow": () => page(`<h1>Slow</h1><script>addEventListener('load',()=>{setTimeout(()=>fetch('/delay?ms=1500').then(()=>{document.title='fetched'}),300)})</script>`),
  "/modal": () => page(`<h1>Behind</h1><button>Outside</button><dialog id="d"><h2>Confirm</h2><button onclick="d.close()">Close</button><button>Keep</button></dialog><script>d.showModal()</script>`),
  "/form": () =>
    page(`<label>Password <input type="password" value="hunter2-secret"></label>
<label>Card <input autocomplete="cc-number" value="4111111111111111"></label>
<label>Code <input autocomplete="one-time-code" value="928374"></label>
<label>Current <input autocomplete="section-a current-password" value="old-pass-secret"></label>
<label>Name <input value="visible-name"></label>`),
  "/hover": () =>
    page(`<button id="h" style="position:absolute;left:40px;top:100px;width:120px;height:40px" onclick="document.title='clicked'">Hover me</button>
<script>document.getElementById('h').addEventListener('mouseover', () => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.2)'; d.textContent = 'Overlay'; document.body.appendChild(d); }, { once: true });</script>`),
  "/double": () =>
    page(`<button id="d" style="position:absolute;left:40px;top:100px;width:120px;height:40px">Twice</button>
<script>window.seen = []; const d = document.getElementById('d'); d.addEventListener('click', (e) => seen.push('click' + e.detail)); d.addEventListener('dblclick', () => seen.push('dblclick'));</script>`),
  "/hostile": () => {
    const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const strings = HOSTILE_STRINGS.map(({ value }) => value).filter((value) => typeof value === "string");
    const buttons = strings.map((value, i) => `<button aria-label="${esc(value)}">b${i}</button><input aria-label="field ${i}" value="${esc(value)}">`).join("");
    return page(`${buttons}<button aria-label="${"x".repeat(100000)}">long</button>
<label>Card <input id="sep-ff" value="4000056655665556"></label>
<label>Code <input id="sep-cr" value="551199"></label>
<label>Pass <input id="sep-tab" value="new-secret-77"></label>
<script>
document.getElementById('sep-ff').setAttribute('autocomplete', 'shipping\\fcc-number');
document.getElementById('sep-cr').setAttribute('autocomplete', 'section-a\\rone-time-code');
document.getElementById('sep-tab').setAttribute('autocomplete', 'username\\tnew-password');
window.separators = ['sep-ff', 'sep-cr', 'sep-tab'].map((id) => [...document.getElementById(id).getAttribute('autocomplete')].map((c) => c.charCodeAt(0)).filter((code) => code < 32).join(':')).join(',');
</script>`);
  },
  "/scroll": () => page(`<div style="height:2400px"></div><button id="far" onclick="document.title='far'">Far button</button><div style="height:400px"></div>`),
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/delay") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, Number(url.searchParams.get("ms") ?? 1000));
    return;
  }
  const route = pages[url.pathname];
  res.writeHead(route ? 200 : 404, { "content-type": "text/html" });
  res.end(route ? route() : "");
});
await new Promise((done) => server.listen({ port: 0, host: "127.0.0.1" }, done));
port = server.address().port;
const origin = `http://localhost:${port}`;

let appPid = 0;
let client = null;
function cleanup(code) {
  try { client?.socket.destroy(); } catch {}
  if (appPid) {
    try { process.kill(appPid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) {
      if (!isAlive(appPid)) break;
      execFileSync("sleep", ["0.1"]);
    }
    try { process.kill(appPid, "SIGKILL"); } catch {}
  }
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.log("FAIL  the check ran past its 6 minute deadline");
  cleanup(2);
}, 360_000).unref();

const appProcesses = () => {
  try {
    return new Set(execFileSync("pgrep", ["-f", join(app, "Contents", "MacOS")]).toString().trim().split("\n").filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
};
const before = appProcesses();
execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, ...(metroArg ? ["--env", `ARDIA_INSTANCE=jsLocation=${metroArg}`] : []), "--stdout", join(data, "app.out.log"), "--stderr", join(data, "app.out.log"), app]);

for (let i = 0; i < 100 && !appPid; i++) {
  appPid = [...appProcesses()].find((pid) => !before.has(pid)) ?? 0;
  if (!appPid) execFileSync("sleep", ["0.1"]);
}

function connect(path) {
  return new Promise((done, fail) => {
    const socket = net.connect(path);
    let buffer = "";
    let nextId = 0;
    const waiting = new Map();
    const events = [];
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.event) events.push(msg);
        else waiting.get(msg.id)?.(msg);
      }
    });
    socket.on("error", fail);
    socket.on("connect", () =>
      done({
        socket,
        events,
        call: (method, params) =>
          new Promise((answer) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              waiting.delete(id);
              answer({ error: { code: "timeout", message: `no reply to ${method} in 30 s` } });
            }, 30_000);
            waiting.set(id, (msg) => {
              clearTimeout(timer);
              waiting.delete(id);
              answer(msg);
            });
            socket.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
          }),
      }),
    );
  });
}

const sockPath = join(data, "ArdiaControl.sock");
for (let i = 0; i < 300 && !client; i++) {
  if (fs.existsSync(sockPath)) {
    try {
      client = await connect(sockPath);
      const hello = await client.call("hello", {});
      if (hello.error) {
        client.socket.destroy();
        client = null;
        await sleep(300);
      }
    } catch {
      client = null;
      await sleep(300);
    }
  } else await sleep(300);
}
if (!client) {
  console.log("FAIL  the control socket never answered");
  cleanup(1);
}
const status = await client.call("windows", {});
for (let i = 0; i < 40 && !(status.result ?? []).length; i++) await sleep(250);
if (!appPid) {
  try {
    appPid = Number(execFileSync("lsof", ["-t", sockPath]).toString().trim().split("\n")[0]) || 0;
  } catch {}
}
check("the instance runs with no DevTools port", !fs.existsSync(join(data, "Chromium", "DevToolsActivePort")));

const ok = async (method, params) => {
  const reply = await client.call(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const run = async (name, work) => {
  try {
    await work();
  } catch (error) {
    check(name, false, String(error?.message ?? error));
  }
};

async function openTab(path, activate = false) {
  const applied = await ok("apply", { ops: [{ op: "open", urls: [`${origin}${path}`], ...(activate ? { activate: true } : {}) }] });
  const tab = applied.results?.[0]?.tabs?.[0] ?? applied.tabs?.[0];
  for (let i = 0; i < 60; i++) {
    const row = await client.call("tabs.get", { tab });
    if (row.result && !row.result.loading && row.result.url?.includes(path)) break;
    await sleep(250);
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const settled = await client.call("tabs.waitSettled", { tab, timeoutMs: 8000 });
    if (!settled.error) break;
    await sleep(150);
  }
  return tab;
}

async function snapshotOf(tab, params = {}) {
  for (let attempt = 0; ; attempt++) {
    const reply = await client.call("tabs.snapshot", { tab, ...params });
    if (!reply.error && (reply.result.counts.nodes > 3 || attempt >= 20)) return reply.result;
    if (!reply.error) {
      await sleep(250);
      continue;
    }
    if (attempt >= 20 || !/navigated|no such tab/.test(reply.error.message ?? "")) throw new Error(`tabs.snapshot: ${JSON.stringify(reply.error)}`);
    if (/no such tab/.test(reply.error.message ?? "")) await sleep(150);
    else await client.call("tabs.waitSettled", { tab, timeoutMs: 5000 });
  }
}

const shown = await openTab("/main", true);
const background = await openTab("/scroll");

let attached = null;
await run("devtools.attach opens a session with no prompt and events come back on the connection", async () => {
  attached = await ok("devtools.attach", { tab: shown });
  const before = client.events.length;
  await ok("devtools.send", { session: attached.session, method: "Runtime.enable" });
  await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "console.log('ping-4055')" } });
  for (let i = 0; i < 40 && !client.events.slice(before).some((e) => e.event === "devtools.event" && e.data.method === "Runtime.consoleAPICalled"); i++) await sleep(100);
  const consoleEvent = client.events.slice(before).find((e) => e.event === "devtools.event" && e.data.method === "Runtime.consoleAPICalled");
  check("a console event is pushed on the connection", consoleEvent?.data.params?.args?.[0]?.value === "ping-4055", consoleEvent);
  const value = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "1+2", returnByValue: true } });
  check("devtools.send answers a command", value.result?.result?.value === 3, value);
  const batch = await ok("devtools.batch", { session: attached.session, commands: [{ method: "Runtime.evaluate", params: { expression: "location.pathname", returnByValue: true } }, { method: "No.suchMethod" }, { method: "Runtime.evaluate", params: { expression: "2" } }] });
  check("devtools.batch answers in order and stops at the first error", batch.completed === 1 && batch.stopped && batch.results[0].result?.result?.value === "/main", batch);
  const auto = await ok("devtools.send", { session: attached.session, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
  for (let i = 0; i < 20 && !client.events.some((e) => e.data?.method === "Target.attachedToTarget"); i++) await sleep(100);
  const child = client.events.find((e) => e.data?.method === "Target.attachedToTarget" && e.data.params?.targetInfo?.type === "iframe");
  check("a flattened child session for the cross-site iframe is reported", !!child && !!auto, child?.data.params?.targetInfo);
  if (child) {
    const inFrame = await ok("devtools.send", { session: attached.session, sessionId: child.data.params.sessionId, method: "Runtime.evaluate", params: { expression: "location.host", returnByValue: true } });
    check("a command runs in the child session", String(inFrame.result?.result?.value).startsWith("127.0.0.1"), inFrame);
  }
});

let snap = null;
await run("tabs.snapshot", async () => {
  snap = await ok("tabs.snapshot", { tab: shown });
  const by = (name) => snap.refs.find((r) => r.name === name);
  const save = by("Save");
  const frameButton = by("Frame button");
  const shadow = by("Shadow action");
  check("the snapshot lists the page, the cross-site iframe's button and the closed shadow root's button", !!save && !!frameButton && !!shadow && snap.counts.frames >= 2, snap.refs.map((r) => `${r.ref}:${r.role}:${r.name ?? ""}`));
  const rect = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "JSON.stringify(document.getElementById('save').getBoundingClientRect())", returnByValue: true } });
  const real = JSON.parse(rect.result.result.value);
  const off = save ? Math.max(Math.abs(save.box[0] - real.x), Math.abs(save.box[1] - real.y), Math.abs(save.box[2] - real.width), Math.abs(save.box[3] - real.height)) : 999;
  check("a ref's box matches the page's own geometry within a pixel", off <= 1, { box: save?.box, real });
  const frameReal = { x: 40 + 20, y: 120 + 20 };
  check("an iframe's element is placed in the main viewport", frameButton && Math.abs(frameButton.box[0] - (40 + 8)) <= 30 && Math.abs(frameButton.box[1] - 128) <= 30, { box: frameButton?.box, frameReal });
  check("the covered Save button says what covers it", !!save?.occludedBy && snap.refs.some((r) => r.ref === save.occludedBy && r.blocker), save);
  const again = await ok("tabs.snapshot", { tab: shown });
  check("refs stay the same across snapshots", again.refs.find((r) => r.name === "Save")?.ref === save?.ref);
});

await run("tabs.hitTest and tabs.click", async () => {
  const save = snap.refs.find((r) => r.name === "Save");
  const hit = await ok("tabs.hitTest", { tab: shown, ref: save.ref });
  check("the hit test says the banner covers Save", hit.blocked === true && !!hit.blocker, hit);
  check("the banner's dismiss button is found, reject before accept", hit.dismiss?.name === "Reject all" && hit.dismiss?.kind === "reject" && hit.choices?.length === 2, hit.dismiss);
  const held = await ok("tabs.click", { tab: shown, ref: save.ref });
  check("a click on the covered button is held back", held.clicked === false && held.blocked === true, held);
  const dismissed = await ok("tabs.click", { tab: shown, ref: hit.dismiss.ref });
  check("clicking the dismiss button lands", dismissed.clicked === true, dismissed);
  await sleep(200);
  await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.getElementById('save').addEventListener('click', (e) => { window.trustedClick = e.isTrusted; })" } });
  const clicked = await ok("tabs.click", { tab: shown, ref: save.ref });
  const title = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.title + ':' + window.trustedClick", returnByValue: true } });
  check("the click lands once the banner is gone, as trusted input", clicked.clicked === true && title.result.result.value === "saved:true", { clicked, title: title.result.result.value });
  const frameButton = snap.refs.find((r) => r.name === "Frame button");
  const frameClick = await ok("tabs.click", { tab: shown, ref: frameButton.ref });
  await sleep(300);
  const frameTitle = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("a click inside the cross-site iframe lands", frameClick.clicked === true && frameTitle.result.result.value === "frame", { frameClick, title: frameTitle.result.result.value });
  const shadow = snap.refs.find((r) => r.name === "Shadow action");
  await ok("tabs.click", { tab: shown, ref: shadow.ref });
  const shadowTitle = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("a click on a closed shadow root's button lands", shadowTitle.result.result.value === "shadow", shadowTitle.result.result.value);
  await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "rerender()" } });
  const rebound = await ok("tabs.click", { tab: shown, ref: save.ref });
  check("a ref whose element was replaced is found again by role and name", rebound.clicked === true && rebound.rebound === true, rebound);
});

await run("tabs.click scrolls a far element into view", async () => {
  const far = (await ok("tabs.snapshot", { tab: background })).refs.find((r) => r.name === "Far button");
  check("the far button is listed as offscreen", far?.offscreen === true, far);
  const clicked = await ok("tabs.click", { tab: background, ref: far.ref });
  const session = await ok("devtools.attach", { tab: background });
  const title = await ok("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("the click scrolled it into view and landed, on a tab that isn't shown", clicked.clicked === true && title.result.result.value === "far", { clicked, title: title.result.result.value });
  await ok("devtools.detach", { session: session.session });
});

await run("a DevTools session reaches only its own tab", async () => {
  const session = await ok("devtools.attach", { tab: shown });
  const listed = await client.call("devtools.send", { session: session.session, method: "Target.getTargets" });
  const attached = await client.call("devtools.send", { session: session.session, method: "Target.attachToTarget", params: { targetId: "0".repeat(32), flatten: true } });
  const created = await client.call("devtools.send", { session: session.session, method: "Target.createTarget", params: { url: "about:blank" } });
  check("Target.getTargets, attachToTarget and createTarget are refused", !!listed.error && !!attached.error && !!created.error, { listed: listed.error, attached: attached.error, created: created.error });
  const permission = await client.call("devtools.send", { session: session.session, method: "Browser.setPermission", params: { permission: { name: "geolocation" }, setting: "granted", origin: "https://example.com" } });
  const cookies = await client.call("devtools.send", { session: session.session, method: "Network.getAllCookies" });
  const version = await client.call("devtools.send", { session: session.session, method: "Browser.getVersion" });
  const scoped = (reply) => /reaches only its own tab/.test(reply.error?.message ?? "");
  check("browser-wide Browser and cookie commands are refused, Browser.getVersion is left to Chromium", scoped(permission) && scoped(cookies) && !scoped(version), { permission: permission.error, cookies: cookies.error, version: version.error ?? "answered" });
  await ok("devtools.detach", { session: session.session });
});

await run("Ardia's own and chrome:// pages are refused on attach, snapshot and screenshot", async () => {
  const opened = await ok("apply", { ops: [{ op: "open", urls: ["ardia://history"], activate: true }] });
  const tab = opened.results?.[0]?.tabs?.[0];
  await sleep(1500);
  const replies = {
    attach: await client.call("devtools.attach", { tab }),
    snapshot: await client.call("tabs.snapshot", { tab }),
    screenshot: await client.call("tabs.screenshot", { tab }),
    settle: await client.call("tabs.waitSettled", { tab, timeoutMs: 500 }),
  };
  check("every entry point refuses it", Object.values(replies).every((reply) => !!reply.error), Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, v.error?.message ?? "answered"])));
  const spare = await openTab("/frame");
  const session = await ok("devtools.attach", { tab: spare });
  const navigated = await client.call("devtools.send", { session: session.session, method: "Page.navigate", params: { url: "chrome://version" } });
  await sleep(1500);
  const after = await client.call("tabs.snapshot", { tab: spare });
  const detached = client.events.some((e) => e.event === "devtools.detached" && e.data.session === session.session);
  const command = await client.call("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } });
  check("a session can't follow its tab into a chrome:// page", !!navigated.error || (detached && !!after.error && !!command.error), { navigated: navigated.error ?? "navigated", detached, after: after.error?.message ?? "answered", command: command.error?.message ?? "answered" });
  await client.call("devtools.detach", { session: session.session });
});

await run("a scaled iframe holding an unscaled iframe is placed and clicked at 2x, not 4x", async () => {
  const tab = await openTab("/scaled", true);
  let deep;
  for (let i = 0; i < 20 && !deep?.box; i++) {
    deep = (await snapshotOf(tab)).refs.find((r) => r.name === "Deep");
    if (!deep?.box) await sleep(250);
  }
  const box = deep?.box ?? [];
  const expected = [80, 160, 160, 60];
  check("the inner button's box is the page's own geometry", box.length === 4 && box.every((v, i) => Math.abs(v - expected[i]) <= 3), { box, expected });
  const clicked = await ok("tabs.click", { tab, ref: deep.ref });
  await sleep(300);
  const session = await ok("devtools.attach", { tab });
  const title = await ok("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  await ok("devtools.detach", { session: session.session });
  check("a click on the nested button lands", clicked.clicked === true && title.result.result.value === "deep", { clicked, title: title.result.result.value });
});

await run("a double click sends both clicks and the dblclick", async () => {
  const tab = await openTab("/double", true);
  const button = (await snapshotOf(tab)).refs.find((r) => r.name === "Twice");
  const clicked = await ok("tabs.click", { tab, ref: button.ref, clickCount: 2 });
  const session = await ok("devtools.attach", { tab });
  const seen = await ok("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "seen.join(',')", returnByValue: true } });
  check("click1, click2 and dblclick arrive in order", clicked.clicked === true && seen.result.result.value === "click1,click2,dblclick", { clicked: clicked.clicked, seen: seen.result.result.value });
  await ok("devtools.detach", { session: session.session });
});

await run("a double click stops after the first click when that click removes its iframe", async () => {
  const tab = await openTab("/vanish", true);
  let vanish;
  for (let i = 0; i < 20 && !vanish?.box; i++) {
    vanish = (await snapshotOf(tab)).refs.find((r) => r.name === "Vanish");
    if (!vanish?.box) await sleep(250);
  }
  const reply = await client.call("tabs.click", { tab, ref: vanish.ref, clickCount: 2 });
  await sleep(200);
  const session = await ok("devtools.attach", { tab });
  const counts = await ok("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "[hits, under, !!document.getElementById('vf')].join(',')", returnByValue: true } });
  await ok("devtools.detach", { session: session.session });
  check("the second press never reaches the page under the removed iframe", /stopped after 1 of 2/.test(reply.error?.message ?? "") && counts.result.result.value === "1,0,false", { reply: reply.error?.message ?? reply.result, counts: counts.result.result.value });
});

await run("hostile page text stays bounded and sensitive values stay hidden at the snapshot sink", async () => {
  const tab = await openTab("/hostile");
  const session = await ok("devtools.attach", { tab });
  const separators = await ok("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "window.separators", returnByValue: true } });
  await ok("devtools.detach", { session: session.session });
  check("the page really holds form feed, carriage return and tab in autocomplete", separators.result.result.value === "12,13,9", separators.result.result.value);
  const shot = await snapshotOf(tab, { maxRefs: 2000, maxTextBytes: 524288 });
  const text = JSON.stringify(shot);
  const longest = Math.max(...shot.refs.map((r) => Buffer.byteLength(r.name ?? "") + Buffer.byteLength(r.value ?? "")));
  check("every name and value is cut to its budget", longest <= 400, longest);
  check("the reply fits one socket line", Buffer.byteLength(text) < 1024 * 1024, Buffer.byteLength(text));
  const secrets = ["4000056655665556", "551199", "new-secret-77"];
  check("autocomplete split on form feed, carriage return and tab still redacts", secrets.every((secret) => !text.includes(secret)), secrets.filter((secret) => text.includes(secret)));
  check("those three fields are marked redacted", shot.refs.filter((r) => r.redacted).length === 3, shot.refs.filter((r) => r.redacted).length);
});

await run("sensitive form values never leave the engine", async () => {
  const tab = await openTab("/form");
  const shot = await snapshotOf(tab);
  const text = JSON.stringify(shot);
  const secrets = ["hunter2-secret", "4111111111111111", "928374", "old-pass-secret"];
  check("password, card number, one-time code and current-password values are absent", secrets.every((secret) => !text.includes(secret)), secrets.filter((secret) => text.includes(secret)));
  const redacted = shot.refs.filter((r) => r.redacted).length;
  check("those four fields are marked redacted", redacted === 4, shot.refs.map((r) => [r.role, r.name, r.redacted, r.value]));
  check("an ordinary field keeps its value", text.includes("visible-name"));
});

await run("clicks that can't be confirmed are refused", async () => {
  const unverified = await ok("tabs.click", { tab: shown, x: 99000, y: 99000 });
  check("a point the hit test can't match is refused", unverified.clicked === false && unverified.reason === "unverified", unverified);
  const tab = await openTab("/hover", true);
  const hover = (await snapshotOf(tab)).refs.find((r) => r.name === "Hover me");
  const moved = await ok("tabs.click", { tab, ref: hover.ref });
  check("a layer that appears when the pointer arrives stops the press", moved.clicked === false && moved.reason === "moved", moved);
});

await run("tabs.snapshot scopes to an open modal dialog", async () => {
  const tab = await openTab("/modal");
  const modal = await snapshotOf(tab);
  check("only the topmost modal is listed", modal.scope === "modal" && modal.refs.some((r) => r.name === "Close") && !modal.refs.some((r) => r.name === "Outside"), modal);
  const whole = await snapshotOf(tab, { wholePage: true });
  check("wholePage takes the page as its scope, where what showModal made inert stays out", whole.scope === "page" && whole.refs.some((r) => r.name === "Close") && !whole.refs.some((r) => r.name === "Outside"), whole.refs.map((r) => r.name));
});

await run("tabs.waitSettled", async () => {
  const tab = (await ok("apply", { ops: [{ op: "open", urls: [`${origin}/slow`] }] })).results?.[0]?.tabs?.[0];
  let settled = null;
  for (let attempt = 0; attempt < 40 && !settled; attempt++) {
    const reply = await client.call("tabs.waitSettled", { tab, timeoutMs: 10000, quietMs: 300 });
    if (!reply.error) settled = reply.result;
    else if (/no such tab/.test(reply.error.message ?? "")) await sleep(50);
    else throw new Error(`tabs.waitSettled: ${JSON.stringify(reply.error)}`);
  }
  check("the wait outlasts the delayed fetch and settles", settled.settled === true && settled.waitedMs >= 1200 && settled.network.seen >= 1 && settled.network.inflight === 0, settled);
  const short = await ok("tabs.waitSettled", { tab, timeoutMs: 100, quietMs: 5000 });
  check("a wait that runs out says so instead of failing", short.settled === false && short.timedOut === true, short);
});

await run("screenshots of a tab that isn't on screen", async () => {
  const shot = await ok("tabs.screenshot", { tab: background });
  const bytes = Buffer.from(shot.data ?? "", "base64");
  check("tabs.screenshot copies a hidden tab's surface", shot.hidden === true && bytes.length > 1000 && bytes[0] === 0xff && bytes[1] === 0xd8 && shot.width > 100, { hidden: shot.hidden, width: shot.width, height: shot.height, bytes: bytes.length });
  const png = await ok("tabs.screenshot", { tab: background, format: "png", clip: { x: 0, y: 0, width: 200, height: 100 } });
  const pngBytes = Buffer.from(png.data ?? "", "base64");
  check("a clipped PNG", pngBytes.slice(1, 4).toString() === "PNG" && png.width >= 200 && png.width <= 800, { width: png.width, height: png.height });
  const session = await ok("devtools.attach", { tab: background });
  const cdp = await ok("devtools.send", { session: session.session, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 60 } });
  check("Page.captureScreenshot on a hidden tab is answered offscreen", typeof cdp.result?.data === "string" && cdp.result.data.length > 1000, { offscreen: cdp.offscreen, size: cdp.result?.data?.length });
  await ok("devtools.detach", { session: session.session });
});

await run("every shared hostile input is refused before the engine acts", async () => {
  let refused = 0;
  let total = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    if (value === undefined) continue;
    const cases = [
      ["devtools.send", { session: attached.session, method: value }],
      ["devtools.send", { session: attached.session, method: "Runtime.evaluate", sessionId: value }],
      ["devtools.send", { session: value, method: "Runtime.evaluate" }],
      ["tabs.click", { tab: shown, ref: value }],
      ["tabs.hitTest", { tab: shown, x: value, y: 10 }],
      ["tabs.snapshot", { tab: value }],
      ["tabs.screenshot", { tab: shown, quality: value }],
      ["tabs.waitSettled", { tab: shown, timeoutMs: value }],
    ];
    for (const [method, params] of cases) {
      const valid =
        (typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && params.method === value) ||
        (typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value) && params.sessionId === value) ||
        (typeof value === "string" && /^e[0-9]{1,9}$/.test(value) && params.ref === value) ||
        (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100000 && params.x === value) ||
        (Number.isSafeInteger(value) && value >= 1 && value <= 100 && params.quality === value) ||
        (Number.isSafeInteger(value) && value >= 100 && value <= 60000 && params.timeoutMs === value) ||
        (Number.isSafeInteger(value) && value >= 1 && params.session === value);
      if (valid) continue;
      total++;
      const reply = await client.call(method, params);
      if (reply.error) refused++;
      else check(`${method} refused ${id}`, false, params);
    }
  }
  check(`all ${total} hostile requests were refused`, refused === total, { refused, total });
});

await run("devtools.detach and a closed tab end sessions", async () => {
  const before = client.events.length;
  const detached = await ok("devtools.detach", { session: attached.session });
  check("devtools.detach ends the session", detached.closed === true);
  const after = await client.call("devtools.send", { session: attached.session, method: "Runtime.evaluate" });
  check("a detached session can't be used", after.error?.code === "no_window", after.error);
  const again = await ok("devtools.attach", { tab: background });
  await ok("apply", { ops: [{ op: "tab.close", tabs: [background] }] }).catch(async () => ok("apply", { ops: [{ op: "tab.close", tab: background }] }));
  for (let i = 0; i < 40 && !client.events.slice(before).some((e) => e.event === "devtools.detached" && e.data.session === again.session); i++) await sleep(100);
  check("closing the tab pushes devtools.detached", client.events.slice(before).some((e) => e.event === "devtools.detached" && e.data.session === again.session));
});

const status2 = await client.call("windows", {});
check("the instance is still serving", !status2.error);
console.log(failures ? `${failures} failed` : "all passed");
cleanup(failures ? 1 : 0);
