import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error(`usage: node peek-hybrid-test.mjs <Debug Ardia.app> [--only=<check,…>] [--keep-data]

Peek's Genie-in, Seamless-after motion (docs/peek-motion.md › Failure scenarios): the page keeps one viewport from Peek
to tab, one uniform scale, the same document and Chrome tab after Open as Tab, a pinch during the warp keeps every
vertex, close and promote race to one outcome, and the fallbacks (no mesh, a throwing mesh, a page that never paints,
reduced motion) still open, pinch and promote. Writes peek-hybrid.json (geometry, identity and frame traces).`);
  process.exit(2);
}
const appPath = resolve(appArg);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const keep = args.includes("--keep-data");
const scratch = mkdtempSync(join(tmpdir(), "ac-peek-hybrid-"));
const rep = reporter(join(scratch, "peek-hybrid-test.log"), { name: "peek-hybrid-test" });
const artifact = { started: new Date().toISOString(), app: appPath, checks: {} };
const wanted = (name) => !only || only.includes(name);

const tone = (() => {
  const rate = 8000, samples = rate * 30;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 3000), 44 + i * 2);
  return buf;
})();
const rows = Array.from({ length: 160 }, (_, i) => `<div class=row>row ${i}</div>`).join("");
const PAGE = `<!doctype html><title>peek target</title><style>body{margin:0;font:16px system-ui;background:#3a7}.row{height:40px;border-bottom:1px solid #ccc}#hit{position:fixed;left:200px;top:140px;width:180px;height:120px;background:#4a7}</style>
<input id=f><div id=hit></div><audio id=a muted src="/tone.wav"></audio>${rows}
<script>window.__nonce=Math.random().toString(36).slice(2);window.__resizes=0;window.__sizes=[];addEventListener("resize",()=>{__resizes++;__sizes.push([innerWidth,innerHeight,performance.now()])});window.__vis=[];document.addEventListener("visibilitychange",()=>__vis.push([document.visibilityState,performance.now()]));window.__over=[];addEventListener("mouseover",e=>__over.push(e.target.id),true);window.__wheel=[];addEventListener("wheel",e=>__wheel.push([e.clientX,e.clientY,e.deltaY]),true);
window.__clicks=[];addEventListener("mousedown",e=>__clicks.push({x:e.clientX,y:e.clientY,target:e.target.id}),true);window.__ups=[];addEventListener("mouseup",e=>__ups.push({x:e.clientX,y:e.clientY}),true);window.__domClicks=0;addEventListener("click",()=>__domClicks++,true);</script>`;
const SOURCE = `<!doctype html><title>peek source</title><body style="margin:0;font:16px system-ui"><p style="margin:80px">source <a id=l href="/page.html">link</a></p>`;
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/tone.wav") return res.writeHead(200, { "content-type": "audio/wav" }).end(tone);
  res.writeHead(200, { "content-type": "text/html" }).end(path.startsWith("/page") ? PAGE : SOURCE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const WIDTH = 1280, HEIGHT = 800;
const fixture = session({ windows: [{ id: "w1", frame: [80, 80, WIDTH, HEIGHT] }], tabs: [{ id: "a", url: `${base}/source.html` }], settings: { addressBar: "toolbar" } });

const HELPERS = `
const st = () => ac.store.getState();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const stage = () => globalThis.expo.modules.ArdiaPeekStage.devState("w1").then((s) => s.reduce((a, b) => (!a || b.generation > a.generation ? b : a), null));
const fresh = (s) => s && (!s.detached || s.phase === "finished");
const until = (test, ms = 3000, end = Date.now() + ms) => stage().then((s) => (fresh(s) && test(s)) || Date.now() > end ? s : settle(8).then(() => until(test, ms, end)));
const open = (n) => st().openPeek("a", "${base}/page.html?n=" + n, { x: 240, y: 260 });
const magnify = (s, phase, magnification) => { const c = s.geometry.card, o = s.stageInWindow;
  return globalThis.expo.modules.ArdiaMagnifyArea.devMagnify("w1", o.x + c.x + c.width / 2, o.y + c.y + c.height / 2, [{ phase, magnification }]); };
const steps = (s, list) => { let total = 0; return list.reduce((p, [phase, m]) => p.then(() => { const delta = phase === "began" ? m : m - total; total = phase === "began" ? m : m; return magnify(s, phase, delta); }).then(() => settle(16)), Promise.resolve()); };
const summary = (s) => s && ({ layerHasMesh: s.layerHasMesh, meshInspected: s.meshInspected, windowNumber: s.windowNumber, phase: s.phase, entrance: s.entrance, generation: s.generation, meshFailure: s.meshFailure, topDown: s.topDown, events: s.events, freezes: s.freezes, geometry: s.geometry, stageInWindow: s.stageInWindow, pageInWindow: s.pageInWindow, trace: s.trace });
const active = () => { const w = st().windows.w1; return w.activeTabIds[w.profileId] ?? null; };
const post = (s, phase, m) => { const c = s.geometry.card, o = s.stageInWindow; return globalThis.expo.modules.ArdiaPeekStage.devPostMagnify("w1", o.x + c.x + c.width / 2, o.y + c.y + c.height / 2, phase, m); };
const realSteps = (s, list) => list.reduce((p, [phase, m]) => p.then(() => post(s, phase, m)).then(() => settle(16)), Promise.resolve());
const escape = () => ac.shell.devKeyEquivalent("w1", { key: "\\u001b", keyCode: 53, modifiers: [], send: true, asKey: true, wait: 30 });
const command = (name) => ac.runCommand({ command: name, arg: null, windowId: "w1" });
`;

let app = null;
const run = (body, timeout = 20000) => app.eval(`${HELPERS}\n${body}`, { timeout });
const frames = () => run(`return globalThis.expo.modules.ArdiaPeekStage.devPageFrames("w1");`);
const closeAll = () => run(`if (st().peeks.a) st().closePeek("a"); const extra = st().windows.w1.tabIds.filter((id) => id !== "a"); for (const id of extra) st().closeTab(id); st().activate("a"); return settle(300);`);
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

async function start(test = {}, switchOverrides) {
  await app?.quit().catch(() => {});
  const data = join(scratch, `data-${Object.keys(test).join("-") || (switchOverrides ? "switch" : "default")}`);
  app = await launch(appPath, { data, session: fixture, onboarded: true, test, ...(switchOverrides ? { switchOverrides } : {}) });
  await run(`return settle(1500);`);
}

async function check(name, fn) {
  if (!wanted(name)) return;
  await rep.check(name, async () => {
    const record = {};
    artifact.checks[name] = record;
    try {
      await fn(record);
    } finally {
      writeFileSync(join(scratch, "peek-hybrid.json"), JSON.stringify(artifact, null, 1));
    }
  });
}

const restScale = (g) => g.rest.width / g.page.width;

const stateOf = () => run(`return stage().then(summary);`);
const waitFor = async (test, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const s = await stateOf();
    if ((s && (!s.detached || s.phase === "finished") && test(s)) || Date.now() > end) return s;
    await sleep(30);
  }
};
const store = (expr) => run(`return ${expr};`);

try {
  await start();

  await check("viewport-identity-handoff", async (record) => {
    await closeAll();
    const tabId = await run(`return open("v");`);
    await waitFor((s) => s.phase === "open");
    const page = await app.page("page.html?n=v");
    await page.eval(`document.querySelector("#a").play().catch(() => {}); 0`, { userGesture: true });
    await page.eval(`document.querySelector("#f").value = "kept text"; history.pushState({}, "", location.href + "&step=1"); scrollTo(0, 1500); 0`);
    await sleep(600);
    const read = `({ nonce: __nonce, w: innerWidth, h: innerHeight, history: history.length, value: document.querySelector("#f").value, scroll: scrollY, time: document.querySelector("#a").currentTime, resizes: __resizes, sizes: __sizes, vis: __vis })`;
    const before = await page.eval(read);
    const peek = await stateOf();
    const peekView = (await frames()).find((f) => f.tabId === tabId);
    const target = (await app.pageTarget("page.html?n=v")).id;
    await run(`command("openFile"); return settle(40);`);
    const mid = await page.eval(`({ w: innerWidth, h: innerHeight })`);
    const promoted = await waitFor((s) => s.phase === "finished", 3000);
    await sleep(700);
    const after = await page.eval(read);
    const tabView = (await frames()).find((f) => f.tabId === tabId);
    const targetAfter = (await app.pageTarget("page.html?n=v"))?.id;
    const placed = await store(`({ inWindow: st().windows.w1.tabIds.includes(${JSON.stringify(tabId)}), peek: !!st().peeks.a })`);
    Object.assign(record, { tabId, before, mid, after, peekView, tabView, target, targetAfter, placed, peek, promoted });
    page.close();
    assert.equal(placed.inWindow, true, "promoted tab is in the window");
    assert.equal(placed.peek, false);
    assert.deepEqual([mid.w, mid.h], [before.w, before.h], "viewport mid-promote");
    assert.deepEqual([after.w, after.h], [before.w, before.h], "viewport after promote");
    assert.equal(after.nonce, before.nonce, "same document");
    assert.equal(after.history, before.history);
    assert.equal(after.value, before.value);
    near(after.scroll, before.scroll, 1, "scroll");
    assert.ok(after.time >= before.time, `media time kept: ${before.time} → ${after.time}`);
    assert.equal(targetAfter, target, "same DevTools target");
    assert.equal(tabView.browserId, peekView.browserId, "same Chrome tab");
    for (const k of ["x", "y", "width", "height"]) near(tabView.frame[k], peekView.frame[k], 0.5, `web view frame ${k}`);
    const k = restScale(peek.geometry);
    for (const f of [...peek.trace, ...promoted.trace].filter((f) => f.phase !== "waiting" && f.phase !== "finished")) near(f.page[0], f.card[0] * k, 1e-6, "page scale = card scale × k");
    const last = promoted.trace.filter((f) => f.phase === "finished").at(0) ?? promoted.trace.at(-1);
    near(last.page[0], 1, 1e-9, "final scale");
    near(last.page[1], 0, 1e-6, "final x");
    near(last.page[2], 0, 1e-6, "final y");
    assert.deepEqual(after.vis.slice(before.vis.length), [], "the page never went hidden during the hand-over (the Peek host kept it until the tab's host had it)");
    assert.equal(after.resizes, 0, "no resize event");
    const final = await stateOf();
    record.donorEvents = final?.events?.map((e) => e.event);
    assert.ok(final?.events?.some((e) => e.event === "donated"), "the Peek host gave the page up in place");
  });

  await check("handoff-autohide", async (record) => {
    await closeAll();
    await run(`st().updateSettings({ hideToolbarWhileScrolling: true }); return settle(400);`);
    const tabId = await run(`return open("ah");`);
    await waitFor((s) => s.phase === "open");
    const page = await app.page("page.html?n=ah");
    const read = `({ w: innerWidth, h: innerHeight, resizes: __resizes, vis: __vis })`;
    const before = await page.eval(read);
    await run(`command("openFile"); return settle(30);`);
    const mid = await page.eval(`({ w: innerWidth, h: innerHeight })`);
    await sleep(900);
    const after = await page.eval(read);
    page.close();
    await run(`st().updateSettings({ hideToolbarWhileScrolling: false }); return settle(300);`);
    Object.assign(record, { tabId, before, mid, after });
    assert.deepEqual([mid.w, mid.h, after.w, after.h], [before.w, before.h, before.w, before.h], "viewport kept with auto-hide toolbars");
    assert.equal(after.resizes, 0);
    assert.deepEqual(after.vis.slice(before.vis.length), []);
  });

  await check("handoff-cancel", async (record) => {
    await closeAll();
    const tabId = await run(`return open("hc");`);
    await waitFor((s) => s.phase === "open");
    const out = await run(`command("openFile"); return until((x) => x.phase === "finished", 3000).then(() => { st().closeTab(${JSON.stringify(tabId)}); return settle(1500); })
      .then(() => globalThis.expo.modules.ArdiaPeekStage.devPageFrames("w1")).then((f) => ({ frames: f.filter((x) => x.tabId === ${JSON.stringify(tabId)}), tab: !!st().tabs[${JSON.stringify(tabId)}] }));`);
    const target = await app.pageTarget("page.html?n=hc");
    Object.assign(record, { tabId, out, target: !!target });
    assert.equal(out.tab, false);
    assert.deepEqual(out.frames, [], "no host keeps the page");
    assert.equal(!!target, false, "the page itself is gone (not parked)");
  });

  await check("pinch-monitor", async (record) => {
    await closeAll();
    await run(`open("pm"); return 0;`);
    const s = await waitFor((x) => x.phase === "open");
    const out = await run(`return stage().then((s) => realSteps(s, [["began", 0], ["changed", 0.15], ["changed", 0.2]]).then(() => stage()).then((m) => ({ mid: m.phase, m: m.trace.at(-1).m }))
      .then((r) => post(s, "ended", 0).then((last) => settle(900).then(() => ({ ...r, last, peek: !!st().peeks.a, tabs: st().windows.w1.tabIds.length })))));`);
    record.state = out;
    assert.equal(out.mid, "gesture", "real magnify events moved the card");
    assert.ok(out.m > 0.3);
    assert.equal(out.peek, false);
    assert.equal(out.tabs, 2, "release past the threshold opened it as a tab");
    assert.ok(out.last.claimed >= 3 && out.last.seen >= 3, `the monitor saw and claimed them: ${JSON.stringify(out.last)}`);
  });

  await check("rest-capture", async (record) => {
    await closeAll();
    await run(`open("cap"); return 0;`);
    const s = await waitFor((x) => x.phase === "open" && x.events.some((e) => e.event === "painted"));
    await sleep(500);
    const file = join(scratch, "rest.bmp");
    try {
      execFileSync("timeout", ["20", "screencapture", "-x", "-o", "-t", "bmp", "-l", String(s.windowNumber), file]);
    } catch (e) {
      record.blocked = String(e.message);
      throw new Error(`WindowServer capture failed (screen locked?): ${e.message}`);
    }
    const bmp = readFileSync(file);
    const off = bmp.readUInt32LE(10), w = bmp.readInt32LE(18), h = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28) / 8;
    const stride = Math.ceil((w * bpp) / 4) * 4, scale = w / WIDTH;
    const px = (x, y) => { const X = Math.round(x * scale), Y = Math.round(y * scale), row = h > 0 ? h - 1 - Y : Y, i = off + row * stride + X * bpp; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
    const g = s.geometry, o = s.stageInWindow, sh = s.trace.at(-1).shown;
    const y = o.y + sh[1] + sh[3] * 0.3;
    const inside = px(o.x + sh[0] + 4, y), middle = px(o.x + sh[0] + sh[2] / 2, y), outside = px(o.x + g.card.x + 2, y);
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 24);
    Object.assign(record, { inside, middle, outside, shown: sh, card: g.card, size: [w, h, bpp, scale] });
    assert.ok(same(inside, middle), `the page reaches its slot's edge: ${inside} vs ${middle}`);
    assert.ok(!same(outside, middle), "the chrome is outside it");
  });

  await check("shown-again", async (record) => {
    await closeAll();
    await run(`open("sa"); return 0;`);
    const first = await waitFor((x) => x.phase === "open");
    const out = await run(`const other = st().newTab("w1", { url: "${base}/source.html?other=1" });
      return settle(400).then(() => { st().activate("a"); return settle(600); }).then(stage).then((s) => ({ other, s: summary(s), peek: st().peeks.a?.tabId ?? null }));`);
    const back = out.s;
    Object.assign(record, { firstGeneration: first.generation, backGeneration: back?.generation, phase: back?.phase, entering: back?.trace.filter((f) => f.phase === "entering").length, peek: out.peek });
    assert.ok(out.peek, "the Peek came back with its tab");
    assert.equal(back.phase, "open", "it is open again");
    assert.equal(back.generation, first.generation, "the same stage, not a new entrance");
    assert.equal(back.trace.filter((f) => f.phase === "entering" && f.t > first.trace.at(-1).t).length, 0, "no Genie on the way back");
  });

  await check("genie-shape", async (record) => {
    await closeAll();
    await run(`open("gs"); return 0;`);
    const s = await waitFor((x) => x.phase === "open" && x.trace.some((f) => f.warping));
    const frames = s.trace.filter((f) => f.phase === "entering" && f.bbox?.length);
    const enter = s.trace.find((f) => f.phase === "entering"), opened = s.trace.find((f) => f.phase === "open" && f.t > enter.t);
    const narrowest = Math.min(...frames.map((f) => f.bbox[2]));
    Object.assign(record, { narrowest, card: s.geometry.card.width, duration: opened.t - enter.t, frames: frames.length });
    assert.ok(narrowest >= 0.1 * s.geometry.card.width, `neck ${Math.round(narrowest)} of ${Math.round(s.geometry.card.width)}`);
    assert.ok(opened.t - enter.t <= 0.5, `entrance ${Math.round((opened.t - enter.t) * 1000)} ms`);
  });

  for (const via of ["command", "escape", "pinch"]) {
    await check(`close-genie-${via}`, async (record) => {
      await closeAll();
      await run(`open("cg${via}"); return 0;`);
      await waitFor((x) => x.phase === "open");
      if (via === "escape") {
        const page = await app.page(`page.html?n=cg${via}`);
        await page.eval(`document.querySelector("#f").focus(); 0`);
        page.close();
      }
      const out = await run(`return stage().then((s) => ${via === "command" ? 'Promise.resolve(command("closeTab"))' : via === "escape" ? "escape()" : 'realSteps(s, [["began", 0], ["changed", -0.15], ["changed", -0.3], ["ended", 0]])'})
        .then(() => until((x) => x.phase === "finished", 3000)).then(summary).then((d) => settle(300).then(() => ({ d, peek: !!st().peeks.a })));`);
      const closing = out.d.trace.filter((f) => f.phase === "closing");
      Object.assign(record, { closing: closing.length, warped: closing.filter((f) => f.warping).length, peek: out.peek });
      assert.equal(out.peek, false);
      assert.ok(closing.length > 3 && closing.every((f) => f.warping), `close warps back into the link (${closing.filter((f) => f.warping).length}/${closing.length})`);
    });
  }

  for (const ms of [40, 90, 150]) {
    await check(`regrab-genie-${ms}`, async (record) => {
      await closeAll();
      const out = await run(`open("g${ms}");
        return until((s) => s.phase === "entering" || s.phase === "open").then((s0) => {
          if (s0.entrance !== "genie" || s0.phase !== "entering") return { skipped: s0.entrance, phase: s0.phase, meshFailure: s0.meshFailure, events: s0.events };
          let s, frozen;
          return settle(${ms}).then(stage).then((x) => (s = x)).then(() => magnify(s, "began", 0)).then(stage).then((x) => (frozen = x))
            .then(() => steps(s, [["changed", 0.02], ["changed", 0.05], ["changed", 0.08], ["ended", 0.08]]))
            .then(() => until((x) => x.phase === "open", 2000)).then((done) => ({ frozen: summary(frozen), done: summary(done) }));
        });`);
      Object.assign(record, out);
      assert.ok(!out.skipped, `the warp didn't play: ${JSON.stringify(out)}`);
      const freeze = out.frozen.freezes.find((f) => f.event === "pinch");
      assert.ok(freeze, "a freeze was recorded at the pinch");
      assert.ok(freeze.before.length > 0 && freeze.before.length === freeze.after.length, "vertex counts");
      for (let i = 0; i < freeze.before.length; i++) near(freeze.after[i], freeze.before[i], 1e-6, `vertex ${i}`);
      const t = out.done.trace.filter((f) => f.bbox?.length);
      const at = out.frozen.events.find((e) => e.event === "pinch").t;
      const step = (a, b) => Math.max(...a.bbox.map((v, i) => Math.abs(v - b.bbox[i])) );
      const beforeSteps = t.filter((f, i) => i && f.t <= at).map((f, i, arr) => (i ? step(f, arr[i - 1]) : 0));
      const afterIdx = t.findIndex((f) => f.t > at);
      const jump = afterIdx > 0 ? step(t[afterIdx], t[afterIdx - 1]) : 0;
      record.jump = jump;
      record.fastestBefore = Math.max(0, ...beforeSteps);
      assert.ok(jump <= Math.max(2, record.fastestBefore * 1.5), `first frame after the pinch moved ${jump.toFixed(1)} pt (fastest before ${record.fastestBefore.toFixed(1)})`);
      near(freeze.alphaAfter, freeze.alphaBefore, 1e-9, "opacity");
      near(freeze.scrimAfter, freeze.scrimBefore, 1e-9, "scrim");
      const pinchAt = out.frozen.events.find((e) => e.event === "pinch").t;
      const flat = out.done.trace.find((f) => f.t > pinchAt && !f.warping);
      assert.ok(flat && flat.t - pinchAt <= 0.4, `residual settled ${flat ? Math.round((flat.t - pinchAt) * 1000) : "never"} ms after the pinch`);
      const k = restScale(out.done.geometry);
      for (const f of out.done.trace.filter((f) => !f.warping && f.phase !== "waiting")) near(f.page[0], f.card[0] * k, 1e-6, "uniform");
    });
  }

  await check("reversal", async (record) => {
    await closeAll();
    await run(`open("r"); return 0;`);
    await waitFor((s) => s.phase === "open");
    const out = await run(`return stage().then((s) => steps(s, [["began", 0], ["changed", 0.05], ["changed", 0.1], ["changed", 0.2], ["changed", 0.1], ["changed", 0], ["changed", -0.1], ["ended", -0.1]])
      .then(() => settle(60)).then(() => steps(s, [["began", 0], ["changed", 0.03], ["ended", 0.03]]))).then(() => until((x) => x.phase === "open", 2000)).then(summary);`);
    record.state = out;
    const t = out.trace;
    for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i].m - t[i - 1].m) <= 0.11, `m jump at ${i}: ${t[i - 1].m} → ${t[i].m}`);
    const regrab = out.events.filter((e) => e.event === "pinch").at(-1);
    const beforeRegrab = t.filter((f) => f.t < regrab.t).at(-1), afterRegrab = t.find((f) => f.t >= regrab.t);
    near(afterRegrab.m, beforeRegrab.m, 0.03, "regrab keeps the value");
  });

  await check("race", async (record) => {
    await closeAll();
    await run(`open("race1"); return 0;`);
    await waitFor((s) => s.phase === "open");
    const a = await run(`command("closeTab"); command("openFile"); return settle(800).then(stage).then((s) => ({ tabs: st().windows.w1.tabIds.length, peek: !!st().peeks.a, events: s?.events ?? [] }));`);
    await closeAll();
    await run(`open("race2"); return 0;`);
    await waitFor((s) => s.phase === "open");
    const b = await run(`command("openFile"); command("closeTab"); return settle(800).then(() => ({ tabs: st().windows.w1.tabIds.length, peek: !!st().peeks.a }));`);
    Object.assign(record, { closeFirst: a, promoteFirst: b });
    assert.equal(a.peek, false);
    assert.equal(a.tabs, 1, "close won: no tab added");
    assert.ok(a.events.filter((e) => e.event === "done").length <= 1, "at most one outcome");
    assert.equal(b.peek, false);
    assert.equal(b.tabs, 2, "promote won: one tab added");
  });

  await check("replacement", async (record) => {
    await closeAll();
    const out = await run(`open("repA"); return until((x) => x.phase === "entering", 2000).then((s) => { const first = s.generation; const b = open("repB");
      return settle(900).then(stage).then((n) => ({ first, second: n.generation, phase: n.phase, peekTab: st().peeks.a?.tabId ?? null, b })); });`);
    record.state = out;
    assert.ok(out.second > out.first);
    assert.equal(out.peekTab, out.b, "B stays open");
    assert.equal(out.phase, "open");
  });

  await check("navigation", async (record) => {
    await closeAll();
    const out = await run(`open("nav"); return until((x) => x.phase === "entering", 2000).then(() => { st().navigate("a", "${base}/source.html?moved=1", { userInitiated: true }); return settle(900); })
      .then(() => ({ peek: !!st().peeks.a, tabs: st().windows.w1.tabIds.length }));`);
    record.state = out;
    assert.equal(out.peek, false);
    assert.equal(out.tabs, 1, "nothing promoted after the source left");
    await run(`st().navigate("a", "${base}/source.html", { userInitiated: true }); return settle(800);`);
  });

  await check("resize", async (record) => {
    await closeAll();
    const out = await run(`const dev = globalThis.expo.modules.ArdiaDev; let a, frame0;
      open("rs"); return until((x) => x.phase === "entering", 2000).then(() => dev.devSetWindowFrame("w1", [80, 80, 1100, 760])).then((f) => (frame0 = f)).then(() => settle(500)).then(stage).then((s) => (a = s))
      .then(() => { command("openFile"); return settle(60); }).then(() => dev.devSetWindowFrame("w1", [80, 80, ${WIDTH}, ${HEIGHT}])).then(() => settle(900))
      .then(() => ({ a: summary(a), frame0, peek: !!st().peeks.a, tabs: st().windows.w1.tabIds.length }));`);
    record.state = out;
    assert.notEqual(out.a.phase, "entering", "entrance snapped on resize");
    assert.equal(out.a.trace.at(-1).warping, false);
    assert.equal(out.peek, false);
    assert.equal(out.tabs, 2);
  });

  await check("input", async (record) => {
    await closeAll();
    const warp = await run(`open("in"); return until((x) => x.phase === "entering", 2000).then((s) => { const o = s.stageInWindow, c = s.geometry.source, r = s.geometry.rest;
      return ac.shell.devClick("w1", { x: o.x + c.x + c.width / 2, y: o.y + c.y + c.height / 2, queued: true, wait: 30 })
        .then(() => stage()).then((off) => ({ offPhase: off.phase, offPeek: !!st().peeks.a }))
        .then((off) => ac.shell.devClick("w1", { x: o.x + r.x + r.width / 2, y: o.y + r.y + r.height / 2, queued: true, wait: 30 }).then(() => stage()).then((on) => ({ ...off, onPhase: on.phase, phase: s.phase, entrance: s.entrance, settled: on.events.some((e) => e.event === "settled") }))); });`);
    const rest = await waitFor((s) => s.phase === "open");
    const page = await app.page("page.html?n=in");
    const during = await page.eval(`__clicks.length`);
    await page.eval(`__clicks.length = 0`);
    const g = rest.geometry, k = restScale(g), o = rest.stageInWindow;
    const hit = { x: 200 + 90, y: 140 + 60 };
    const shown = { x: o.x + g.rest.x + hit.x * k, y: o.y + g.rest.y + hit.y * k };
    const click = await run(`return ac.shell.devClick("w1", { x: ${shown.x}, y: ${shown.y}, queued: true, wait: 120 });`);
    await sleep(300);
    const clicks = await page.eval(`__clicks`);
    page.close();
    const scrollAt = await run(`return globalThis.expo.modules.ArdiaPeekStage.devPostScroll("w1", ${shown.x}, ${shown.y + 100}, -120).then(() => settle(400));`);
    const page2 = await app.page("page.html?n=in");
    const wheel = await page2.eval(`({ wheel: __wheel, y: scrollY })`);
    await run(`return ac.engine.call("windows.list", {}).then((l) => l.find((w) => w.hasRoot)).then((w) => ac.engine.call("windows.dev", { window: w.window, action: "mouse:moved:${Math.round(shown.x)},${Math.round(shown.y)}" })).then(() => settle(300));`).catch((e) => (record.hoverError = String(e)));
    const over = await page2.eval(`__over.slice(-5)`);
    page2.close();
    Object.assign(record, { warp, during, click, clicks, shown, k, scrollAt, wheel, over });
    record.scrollNote = "a window-less synthetic wheel event can't be dispatched by AppKit; real wheel events are checked by hand";
    assert.ok(over.includes("hit"), `hover reached the target: ${JSON.stringify(over)}`);
    assert.equal(warp.offPeek, true, "a press off the page during the warp leaves the Peek open");
    if (warp.entrance === "genie" && warp.offPhase === "entering") {
      assert.equal(warp.onPhase, "open", "a press over the page during the warp ends the entrance");
      assert.equal(warp.settled, true);
      assert.equal(during, 1, "only the press over the page reached it");
    }
    const last = clicks.at(-1);
    assert.ok(last, "the click at rest reached the page");
    assert.equal(last.target, "hit");
    near(last.x, hit.x, 2, "page x");
    near(last.y, hit.y, 2, "page y");
  });

  await check("wheel-during-warp", async (record) => {
    await closeAll();
    const out = await run(`open("ww"); return until((x) => x.phase === "entering", 2000).then((s) => { const o = s.stageInWindow, r = s.geometry.rest;
      return globalThis.expo.modules.ArdiaPeekStage.devPostScroll("w1", o.x + r.x + r.width / 2, o.y + r.y + r.height / 2, -120).then(() => settle(60)).then(stage)
        .then((after) => ({ entrance: s.entrance, phase: after.phase, settled: after.events.some((e) => e.event === "settled"), peek: !!st().peeks.a })); });`);
    record.state = out;
    assert.equal(out.peek, true);
    if (out.entrance === "genie") {
      assert.equal(out.settled, true, "a wheel over the page during the warp ended the entrance");
      assert.equal(out.phase, "open");
    }
  });

  await check("fullscreen", async (record) => {
    await closeAll();
    await run(`open("fs"); return 0;`);
    await waitFor((s) => s.phase === "open");
    const page = await app.page("page.html?n=fs");
    await page.eval(`document.documentElement.requestFullscreen().then(() => true, (e) => String(e))`, { userGesture: true });
    const full = await waitFor((s) => s.trace.at(-1)?.chrome === 0 && s.trace.at(-1)?.page[0] === 1, 4000);
    const inner = await page.eval(`({ w: innerWidth, h: innerHeight, full: !!document.fullscreenElement })`);
    await page.eval(`document.exitFullscreen().then(() => true, (e) => String(e))`);
    const back = await waitFor((s) => s.phase === "open" && s.trace.at(-1)?.chrome === 1, 4000);
    page.close();
    const last = full.trace.at(-1);
    Object.assign(record, { last, inner, peekAfter: !!(await store(`st().peeks.a`)), backLast: back?.trace.at(-1) });
    assert.equal(inner.full, true, "the page went full screen");
    assert.deepEqual([last.page[0], last.page[1], last.page[2]], [1, 0, 0], "identity transform");
    assert.equal(last.chrome, 0);
    assert.equal(last.scrim, 0);
    assert.equal(last.warping, false);
  });

  await check("fullscreen-during-entrance", async (record) => {
    await closeAll();
    await run(`open("fse"); return 0;`);
    await waitFor((x) => x.phase === "entering", 2000);
    const page = await app.page("page.html?n=fse");
    await page.eval(`document.documentElement.requestFullscreen().then(() => true, (e) => String(e))`, { userGesture: true });
    const full = await waitFor((x) => x.trace.at(-1)?.page[0] === 1 && x.trace.at(-1)?.chrome === 0, 4000);
    const entered = await page.eval(`!!document.fullscreenElement`);
    await page.eval(`document.exitFullscreen().then(() => true, (e) => String(e))`);
    page.close();
    await sleep(800);
    const last = full.trace.at(-1);
    Object.assign(record, { last, entered, layerHasMesh: full.layerHasMesh });
    assert.equal(entered, true, "the page went full screen");
    assert.deepEqual([last.page[0], last.chrome, last.scrim], [1, 0, 0], "full-screen frame");
    assert.equal(last.warping, false);
    assert.equal(full.layerHasMesh, false, "no mesh left on the card");
  });

  await check("escape-during-warp", async (record) => {
    await closeAll();
    const out = await run(`open("esc"); return until((x) => x.phase === "entering", 2000).then(() => escape()).then(() => settle(700))
      .then(() => ({ peek: !!st().peeks.a, tabs: st().windows.w1.tabIds.length }));`);
    record.state = out;
    assert.equal(out.peek, false);
    assert.equal(out.tabs, 1);
  });

  await check("focus", async (record) => {
    await closeAll();
    await run(`open("fo"); return 0;`);
    await waitFor((s) => s.phase === "open");
    const out = await run(`command("openFile"); return until((x) => x.phase === "finished", 3000).then(() => { st().activate("a"); return settle(200); })
      .then(() => ({ active: active() }));`);
    record.state = out;
    assert.equal(out.active, "a", "the tab picked after promotion stays active");
  });

  for (const [name, test, expect] of [
    ["fallback-unavailable", { peekMesh: "unavailable" }, "affine"],
    ["fallback-throws", { peekMesh: "throws" }, "affine"],
    ["kill-switch", "switch", "affine"],
    ["timeout", { peekReady: "never" }, null],
    ["reduced", { peekReduceMotion: true }, "fade"],
  ]) {
    if (!wanted(name)) continue;
    await start(test === "switch" ? {} : test, test === "switch" ? { peekGenie: false } : undefined);
    await check(name, async (record) => {
      const out = await run(`open("${name}"); let entered;
        return until((x) => x.phase === "entering" || x.phase === "open").then((e) => (entered = summary(e))).then(() => until((x) => x.phase === "open"))
          .then((s) => steps(s, [["began", 0], ["changed", 0.35], ["ended", 0.35]])).then(() => until((x) => x.phase === "finished"))
          .then((done) => settle(300).then(() => ({ entered, done: summary(done), tabs: st().windows.w1.tabIds.length, peek: !!st().peeks.a })));`);
      record.state = out;
      const begin = out.done.events.find((e) => e.event === "begin"), entering = out.done.trace.find((f) => f.phase === "entering");
      if (expect) assert.equal(out.entered.entrance, expect);
      if (name.startsWith("fallback")) assert.ok(out.done.meshFailure, "the reason is reported");
      if (name === "fallback-throws") assert.equal(out.done.layerHasMesh, false, "no mesh left after the failed apply");
      if (name === "kill-switch") {
        assert.equal(out.done.meshFailure, "switch");
        assert.equal(out.done.meshInspected, false, "the private mesh runtime was never inspected");
      }
      if (name === "timeout") {
        const wait = entering.t - begin.t;
        assert.ok(wait >= 0.15 - 0.002 && wait <= 0.15 + 0.034, `entrance after ${Math.round(wait * 1000)} ms`);
      }
      if (name === "reduced") {
        const k = restScale(out.done.geometry);
        for (const f of out.done.trace.filter((f) => f.phase === "entering")) near(f.page[0], k, 1e-9, "no scale while fading in");
      }
      assert.equal(out.peek, false, "the pinch promoted it");
      assert.equal(out.tabs, 2);
    });
  }
  if (wanted("press-during-zoom")) {
    await start({ peekMesh: "unavailable", peekSlow: "10" });
    await check("press-during-zoom", async (record) => {
      const s = await run(`open("pz"); return until((x) => x.phase === "entering" && x.trace.at(-1).page[0] > 0.5, 4000).then(summary);`);
      const [k, tx, ty] = s.trace.at(-1).page, g = s.geometry.page, o = s.stageInWindow;
      const at = { x: o.x + tx + k * (g.x + g.width / 2), y: o.y + ty + k * (g.y + g.height / 2) };
      await run(`return ac.shell.devClick("w1", { x: ${at.x}, y: ${at.y}, queued: true, wait: 60 });`);
      const done = await waitFor((x) => x.phase === "open", 3000);
      await sleep(300);
      const page = await app.page("page.html?n=pz");
      const seen = await page.eval(`({ down: __clicks.at(-1) ?? null, up: __ups.at(-1) ?? null, clicks: __domClicks })`);
      page.close();
      Object.assign(record, { entrance: s.entrance, phase: s.phase, settled: done.events.some((e) => e.event === "settled"), seen });
      assert.equal(s.entrance, "affine");
      assert.equal(s.phase, "entering", "the press landed during the zoom");
      assert.ok(seen.down && seen.up, "the page saw the press and its release");
      assert.deepEqual([seen.up.x, seen.up.y], [seen.down.x, seen.down.y], "the release lands where the press did");
      assert.equal(seen.clicks, 1, "the page got one click");
    });
  }
} finally {
  writeFileSync(join(scratch, "peek-hybrid.json"), JSON.stringify(artifact, null, 1));
  rep.say(`artifact: ${join(scratch, "peek-hybrid.json")}`);
  await app?.quit().catch(() => {});
  server.close();
  if (!keep) for (const d of ["data-default", "data-peekMesh", "data-peekReady", "data-peekReduceMotion", "data-switch", "data-peekMesh-peekSlow"]) rmSync(join(scratch, d), { recursive: true, force: true });
}
process.exit(rep.summary() ? 0 : 1);
