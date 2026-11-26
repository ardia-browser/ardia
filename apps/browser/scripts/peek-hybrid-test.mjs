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

Peek's Genie-in, Seamless-after motion (docs/peek-motion.md › Failure scenarios): a resting Peek lays its page out at
the card's own size and draws it 1:1, Open as Tab lays it out once at the tab's size, one uniform scale, the same
document and Chrome tab after Open as Tab, closing asks first when the page has a beforeunload prompt, a pinch during the warp keeps every
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
const SOURCE = `<!doctype html><title>peek source</title><body style="margin:0;font:16px system-ui"><p style="margin:80px">source <a id=l href="/page.html">link</a></p>${rows}<script>window.__wheel=[];addEventListener("wheel",e=>__wheel.push(e.deltaY),true);</script>`;
const beacons = [];
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/beacon") {
    beacons.push(req.url);
    return res.writeHead(204).end();
  }
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
const summary = (s) => s && ({ layerHasMesh: s.layerHasMesh, meshInspected: s.meshInspected, windowNumber: s.windowNumber, phase: s.phase, entrance: s.entrance, generation: s.generation, meshFailure: s.meshFailure, topDown: s.topDown, events: s.events, freezes: s.freezes, chromeTargets: s.chromeTargets, published: s.published, geometry: s.geometry, stageInWindow: s.stageInWindow, pageInWindow: s.pageInWindow, trace: s.trace });
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
const closeOf = (s) => s.chromeTargets?.find((t) => t.surface === "bar" && t.label.startsWith("Close"));
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
    assert.deepEqual([mid.w, mid.h], [after.w, after.h], "the page is laid out at the tab's size as soon as Open as Tab starts");
    assert.equal(after.nonce, before.nonce, "same document");
    assert.equal(after.history, before.history);
    assert.equal(after.value, before.value);
    near(after.scroll, before.scroll, 1, "scroll");
    assert.ok(after.time >= before.time, `media time kept: ${before.time} → ${after.time}`);
    assert.equal(targetAfter, target, "same DevTools target");
    assert.equal(tabView.browserId, peekView.browserId, "same Chrome tab");
    const tabRect = promoted.geometry.tab, stageAt = promoted.stageInWindow;
    for (const k of ["width", "height"]) near(tabView.frame[k], tabRect[k], 0.5, `tab web view ${k}`);
    near(tabView.frame.x, stageAt.x + tabRect.x, 0.5, "tab web view x");
    near(tabView.frame.y, stageAt.y + tabRect.y, 0.5, "tab web view y");
    for (const k of ["width", "height"]) near(peekView.frame[k], peek.geometry.rest[k], 0.5, `resting Peek web view ${k} is its slot`);
    near(restScale(peek.geometry), 1, 1e-9, "a resting Peek's page is laid out at its slot");
    near(peek.trace.at(-1).page[0], 1, 1e-9, "a resting Peek draws its page 1:1");
    near(before.w, peek.geometry.rest.width, 1, "the page's viewport is the card's slot, not the tab's");
    near(after.w, promoted.geometry.tab.width, 1, "the tab's viewport is the tab's size");
    near(after.h, promoted.geometry.tab.height, 1, "the tab's viewport is the tab's height");
    const last = promoted.trace.filter((f) => f.phase === "finished").at(0) ?? promoted.trace.at(-1);
    near(last.page[0], 1, 1e-9, "final scale");
    near(last.page[1], 0, 1e-6, "final x");
    near(last.page[2], 0, 1e-6, "final y");
    assert.deepEqual(after.vis.slice(before.vis.length), [], "the page never went hidden during the hand-over (the Peek host kept it until the tab's host had it)");
    assert.equal(after.resizes - before.resizes >= 1, true, "Open as Tab lays the page out again at the tab's size");
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
    assert.deepEqual([mid.w, mid.h], [after.w, after.h], "laid out at the tab's size from the start of Open as Tab with auto-hide toolbars");
    assert.ok(after.w > before.w, "the tab is wider than the resting Peek");
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
    const scrollAt = await run(`return globalThis.expo.modules.ArdiaPeekStage.devPostScroll("w1", ${shown.x}, ${shown.y + 100}, -120).then((r) => settle(400).then(() => r));`);
    const page2 = await app.page("page.html?n=in");
    const wheel = await page2.eval(`({ wheel: __wheel, y: scrollY })`);
    const edge = { x: o.x + g.rest.x + 12 * k, y: o.y + g.rest.y + 600 * k };
    await page2.eval(`__wheel.length = 0; 0`);
    const edgeAt = await run(`return globalThis.expo.modules.ArdiaPeekStage.devPostScroll("w1", ${edge.x}, ${edge.y}, -120).then((r) => settle(400).then(() => r));`);
    const edgeWheel = await page2.eval(`__wheel`);
    const behind = await app.page("source.html").then((p) => p.eval(`({ wheels: __wheel.length, y: scrollY })`).finally(() => p.close()));
    await run(`return ac.engine.call("windows.list", {}).then((l) => l.find((w) => w.hasRoot)).then((w) => ac.engine.call("windows.dev", { window: w.window, action: "mouse:moved:${Math.round(shown.x)},${Math.round(shown.y)}" })).then(() => settle(300));`).catch((e) => (record.hoverError = String(e)));
    const over = await page2.eval(`__over.slice(-5)`);
    page2.close();
    Object.assign(record, { warp, during, click, clicks, shown, k, scrollAt, wheel, over, edge, edgeAt, edgeWheel, behind });
    assert.ok(over.includes("hit"), `hover reached the target: ${JSON.stringify(over)}`);
    assert.ok(scrollAt.window > 0, `the test wheel event has a window: ${JSON.stringify(scrollAt)}`);
    assert.ok(wheel.wheel.length > 0, "a wheel over the Peek reached its page");
    assert.ok(wheel.y > 0, `the Peek's page scrolled: ${wheel.y}`);
    assert.ok(edgeWheel.length > 0, "a wheel near the Peek page's left edge reached its page, not the page behind");
    near(edgeWheel[0][0], 12, 2, "edge wheel page x");
    assert.deepEqual(behind, { wheels: 0, y: 0 }, "the page behind the Peek got no wheel and didn't scroll");
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
    const back = await waitFor((s) => s.phase === "open" && s.trace.at(-1)?.chrome === 1 && s.published?.chromeShown === true, 4000);
    page.close();
    const last = full.trace.at(-1);
    Object.assign(record, { last, inner, peekAfter: !!(await store(`st().peeks.a`)), backLast: back?.trace.at(-1), fullPublished: full.published, backPublished: back?.published });
    assert.deepEqual(full.published, { chromeShown: false, scrimShown: false }, "full screen publishes the bar and the dim as hidden");
    assert.deepEqual(back?.published, { chromeShown: true, scrimShown: true }, "leaving full screen publishes them as shown again, with no gesture in between");
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

  await check("close-asks-before-leaving", async (record) => {
    await closeAll();
    const tabId = await run(`return open("bu");`);
    const rest = await waitFor((s) => s.phase === "open");
    const page = await app.page("page.html?n=bu");
    await page.eval(`new Promise((r) => (document.readyState === "complete" ? r(0) : addEventListener("load", () => r(0))))`);
    await page.send("Page.enable");
    const dialogs = [];
    const started = Date.now();
    record.dialogEvents = [];
    page.on("Page.javascriptDialogOpening", (d) => (dialogs.push(d.type), record.dialogEvents.push({ open: d.type, ms: Date.now() - started })));
    page.on("Page.javascriptDialogClosed", (d) => record.dialogEvents.push({ closed: d.result, ms: Date.now() - started }));
    await page.eval(`addEventListener("beforeunload", (e) => { navigator.sendBeacon("/beacon?bu=" + Date.now()); e.preventDefault(); e.returnValue = ""; }); document.querySelector("#f").value = "draft"; 0`, { userGesture: true });
    const close = rest.chromeTargets?.find((t) => t.label.startsWith("Close ("));
    record.closeButton = close ?? null;
    assert.ok(close?.reaches, "the Close button is on screen");
    const o = rest.stageInWindow, c = rest.geometry.card;
    const ways = {
      button: () => run(`return ac.shell.devClick("w1", { x: ${close?.x}, y: ${close?.y}, queued: true, wait: 30 });`),
      escape: () => run(`return escape();`),
      closeTab: () => run(`command("closeTab"); return 0;`),
      dim: () => run(`return ac.shell.devClick("w1", { x: ${o.x + c.x / 2}, y: ${o.y + c.y + c.height / 2}, queued: true, wait: 30 });`),
      pinchIn: () => run(`return stage().then((s) => steps(s, [["began", 0], ["changed", -0.3], ["ended", -0.3]]));`),
    };
    const answer = async (accept) => {
      const end = Date.now() + 4000;
      while (dialogs.length === record.asked && Date.now() < end) await sleep(30);
      if (dialogs.length === record.asked) return false;
      record.asked = dialogs.length;
      try {
        await page.send("Page.handleJavaScriptDialog", { accept });
        return true;
      } catch (error) {
        if (!/No dialog is showing/.test(String(error.message))) throw error;
        record.selfDismissed = (record.selfDismissed ?? 0) + 1;
        return accept ? "dismissed" : true;
      }
    };
    const stillOpen = () => store(`({ peek: st().peeks.a?.tabId === ${JSON.stringify(tabId)}, tab: !!st().tabs[${JSON.stringify(tabId)}] })`);
    record.asked = 0;
    record.stays = {};
    await ways.closeTab();
    await sleep(1200);
    await ways.closeTab();
    await ways.closeTab();
    await sleep(600);
    record.repeatWhileAsking = { ...(await stillOpen()), dialogs: dialogs.length, ms: Date.now() - started };
    assert.ok(await answer(false), "the first close asked");
    await sleep(500);
    assert.equal(record.repeatWhileAsking.peek, true, "closing again while the prompt is up never closes the Peek behind it");
    assert.equal((await stillOpen()).peek, true, "Stay after repeated closes keeps the Peek");
    for (const [via, act] of Object.entries(ways)) {
      await act();
      const asked = await answer(false);
      await sleep(500);
      const state = await stillOpen();
      const shown = await stateOf();
      const value = await page.eval(`document.querySelector("#f").value`);
      record.stays[via] = { asked, ...state, phase: shown?.phase, value };
      assert.ok(asked, `${via}: the page's leave prompt showed`);
      assert.equal(state.peek, true, `${via}: Stay keeps the Peek open`);
      assert.equal(shown?.phase, "open", `${via}: the card is back at rest`);
      assert.equal(value, "draft", `${via}: what was typed is still there`);
    }
    let beaconsBeforeLeave = beacons.length;
    for (let attempt = 0; attempt < 3; attempt++) {
      beaconsBeforeLeave = beacons.length;
      await ways.escape();
      record.leaveAsked = await answer(true);
      if (record.leaveAsked !== "dismissed") break;
      await sleep(300);
    }
    await sleep(1500);
    record.left = await stillOpen();
    record.leaveHandlerRuns = beacons.length - beaconsBeforeLeave;
    page.close();
    assert.equal(record.leaveAsked, true, "Leave was asked and answered");
    assert.deepEqual(record.left, { peek: false, tab: false }, "Leave closes the Peek and its page");
    assert.equal(record.leaveHandlerRuns, 1, "Leave runs the page's beforeunload handler once");
    assert.deepEqual(dialogs.every((t) => t === "beforeunload"), true);

    const promoted = await run(`return open("bp");`);
    await waitFor((s) => s.phase === "open");
    const second = await app.page("page.html?n=bp");
    await second.send("Page.enable");
    let promptedOnPromote = false;
    second.on("Page.javascriptDialogOpening", () => void (promptedOnPromote = true));
    await second.eval(`addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; }); document.querySelector("#f").value = "kept"; 0`, { userGesture: true });
    await run(`command("openFile"); return 0;`);
    await waitFor((s) => s.phase === "finished", 3000);
    await sleep(700);
    const after = await store(`({ inWindow: st().windows.w1.tabIds.includes(${JSON.stringify(promoted)}), peek: !!st().peeks.a })`);
    const kept = await second.eval(`document.querySelector("#f").value`);
    second.close();
    Object.assign(record, { promptedOnPromote, after, kept });
    assert.equal(promptedOnPromote, false, "Open as Tab never runs beforeunload");
    assert.deepEqual(after, { inWindow: true, peek: false });
    assert.equal(kept, "kept");
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
        for (const f of out.done.trace.filter((f) => f.phase === "entering")) near(f.page[0], 1, 1e-9, "no scale while fading in");
      }
      assert.equal(out.peek, false, "the pinch promoted it");
      assert.equal(out.tabs, 2);
    });
  }
  for (const via of ["native", "store", "storeStay"]) {
    const name = { native: "window-close-during-leave-prompt", store: "window-teardown-during-leave-prompt", storeStay: "window-teardown-stay-during-leave-prompt" }[via];
    if (!wanted(name)) continue;
    await start({});
    await check(name, async (record) => {
      await run(`open("wc"); return 0;`);
      await waitFor((s) => s.phase === "open");
      const page = await app.page("page.html?n=wc");
      await page.send("Page.enable");
      const dialogs = [];
      page.on("Page.javascriptDialogOpening", (d) => dialogs.push(d.type));
      await page.eval(`addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; }); document.querySelector("#f").value = "draft"; 0`, { userGesture: true });
      await run(`command("closeTab"); return 0;`);
      const asked = async (n, ms = 4000) => { const end = Date.now() + ms; while (dialogs.length < n && Date.now() < end) await sleep(30); return dialogs.length >= n; };
      record.peekAsked = await asked(1);
      await sleep(1200);
      await run(via === "native" ? `globalThis.expo.modules.ArdiaAppWindows.closeWindow("w1"); return 0;` : `st().closeWindow("w1"); return 0;`);
      if (via === "storeStay") {
        await sleep(1200);
        record.stays = 0;
        for (let i = 0; i < 3; i++) {
          if (!(await asked(record.stays + 1, i ? 3000 : 200))) break;
          await page.send("Page.handleJavaScriptDialog", { accept: false }).catch((e) => (record.stayError = String(e.message)));
          record.stays++;
        }
        await sleep(3000);
        record.afterStay = { target: !!(await app.pageTarget("page.html?n=wc")), socketClosed: page.closed };
        record.draft = record.afterStay.target && !page.closed ? await page.eval(`document.querySelector("#f").value`).catch(() => null) : null;
        page.close();
        assert.ok(record.stays >= 1, "the prompt was answered Stay");
        assert.equal(record.afterStay.target, true, "Stay keeps the page: a close deferred during the prompt never unloads it");
        assert.equal(record.draft, "draft", "what was typed is still there after Stay");
        return;
      }
      record.timeline = [];
      for (const ms of [100, 300, 600, 500]) {
        await sleep(ms);
        record.timeline.push({ ms, target: !!(await app.pageTarget("page.html?n=wc")), socketClosed: page.closed, dialogs: dialogs.length });
      }
      record.alive = !page.closed && !!(await app.pageTarget("page.html?n=wc"));
      record.dialogsBeforeStay = dialogs.length;
      if (via === "store") {
        if (record.alive) await page.send("Page.handleJavaScriptDialog", { accept: true }).catch((e) => (record.leaveError = String(e.message)));
      } else {
        if (record.alive) await page.send("Page.handleJavaScriptDialog", { accept: false }).catch((e) => (record.stayError = String(e.message)));
        record.windowAsked = await asked(2);
        if (record.windowAsked) await page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
      await sleep(1500);
      record.goneAfterLeave = !(await app.pageTarget("page.html?n=wc"));
      page.close();
      assert.ok(record.peekAsked, "closing the Peek asked");
      assert.equal(record.alive, true, "closing the window while the Peek's prompt is up never closes the page before it is answered");
      assert.equal(record.dialogsBeforeStay, 1, "one prompt at a time");
      if (via === "native") assert.ok(record.windowAsked, "after Stay, the window close asks the page itself");
      assert.equal(record.goneAfterLeave, true, "Leave closes the page");
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
      const viewport = await (await app.page("page.html?n=pz")).eval(`({ w: innerWidth, h: innerHeight })`);
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
      const settledAt = done.events.find((e) => e.event === "settled")?.t;
      const shown = done.trace.filter((f) => f.t < settledAt && f.phase === "entering").at(-1);
      const expected = shown && { x: (at.x - o.x - shown.page[1]) / shown.page[0] - g.x, y: (at.y - o.y - shown.page[2]) / shown.page[0] - g.y };
      Object.assign(record, { viewport, shownAtPress: shown?.page ?? null, expected });
      assert.ok(expected, "the frame on screen at the press was traced");
      near(seen.down.x, expected.x, 3, "the press reached the point under the pointer (x)");
      near(seen.down.y, expected.y, 3, "the press reached the point under the pointer (y)");
    });
  }
  if (wanted("chrome-press-mid-pinch") || wanted("chrome-hidden-mid-spread") || wanted("chrome-press-held-into-spread") || wanted("chrome-press-held-into-pinch-in") || wanted("side-press-on-invisible-dim")) {
    await start({ peekMesh: "unavailable" });
    const reachableAtRest = (s) => (s.chromeTargets ?? []).filter((t) => t.surface === "bar" && t.reaches);
    const pressAt = (t) => run(`return ac.shell.devClick("w1", { x: ${t.x}, y: ${t.y}, queued: true, wait: 60 });`);
    await check("chrome-press-mid-pinch", async (record) => {
      await closeAll();
      await run(`open("cp"); return 0;`);
      const rest = await waitFor((x) => x.phase === "open");
      const pinched = await run(`return stage().then((s) => realSteps(s, [["began", 0], ["changed", -0.1], ["changed", -0.2]])).then(() => until((x) => x.phase === "gesture" && x.trace.at(-1).card[0] < 0.95)).then(summary);`);
      const atRest = closeOf(rest), mid = closeOf(pinched);
      const pairs = reachableAtRest(rest).map((r) => ({ label: r.label, rest: r, mid: pinched.chromeTargets?.find((t) => t.surface === "bar" && t.label === r.label) ?? null }));
      Object.assign(record, { atRest, mid, pairs, card: pinched.trace.at(-1).card, phase: pinched.phase });
      assert.ok(atRest && mid, `the card's Close button is in its chrome: ${JSON.stringify(rest.chromeTargets)}`);
      assert.equal(pinched.phase, "gesture", "real magnify events are pinching the card");
      assert.ok(pinched.trace.at(-1).card[0] < 0.95, `the card is scaled mid-pinch: ${pinched.trace.at(-1).card}`);
      assert.ok(Math.hypot(mid.x - atRest.x, mid.y - atRest.y) > 8, "the button moved with the card");
      for (const label of ["Close", "Open as Tab"]) assert.ok(pairs.some((p) => p.label.startsWith(label)), `${label} is reachable at rest: ${JSON.stringify(rest.chromeTargets)}`);
      assert.deepEqual(pairs.filter((p) => p.mid?.reaches !== true).map((p) => p.label), [], "every bar button a press reaches at rest is reached where it is drawn mid-pinch");
      const peekBefore = await store(`!!st().peeks.a`);
      record.click = await pressAt(mid);
      const after = await waitFor((x) => x.phase === "finished", 3000);
      record.closed = { phase: after?.phase, peek: await store(`!!st().peeks.a`), events: after?.events?.slice(-6) };
      await run(`return stage().then((s) => post(s, "cancelled", 0)).then(() => settle(300));`).catch(() => {});
      assert.equal(peekBefore, true);
      assert.equal(record.closed.peek, false, `the press on Close while the pinch is still held closed the Peek: ${JSON.stringify(record.closed)}`);
    });
    await check("chrome-press-held-into-spread", async (record) => {
      await closeAll();
      await run(`open("ch"); return 0;`);
      const rest = await waitFor((x) => x.phase === "open");
      const close = closeOf(rest);
      assert.ok(close?.reaches, "Close takes a press at rest");
      record.down = await run(`return ac.shell.devClick("w1", { x: ${close.x}, y: ${close.y}, queued: true, only: "down", wait: 60 });`);
      const spread = await run(`return stage().then((s) => realSteps(s, [["began", 0], ["changed", 0.12], ["changed", 0.2], ["changed", 0.26], ["changed", 0.28]])).then(() => until((x) => x.phase === "gesture" && x.trace.at(-1).chrome <= 0)).then(summary);`);
      record.chrome = spread.trace.at(-1).chrome;
      record.up = await run(`return ac.shell.devClick("w1", { x: ${close.x}, y: ${close.y}, queued: true, only: "up", wait: 60 });`);
      await sleep(600);
      record.after = { peek: await store(`!!st().peeks.a`), phase: (await stateOf())?.phase };
      await run(`return stage().then((s) => post(s, "cancelled", 0)).then(() => settle(600));`).catch(() => {});
      assert.equal(record.chrome, 0, "the bar had faded out before the release");
      assert.equal(record.after.peek, true, "a Close pressed before the bar faded and released while it was invisible doesn't close the Peek");
    });
    await check("chrome-press-held-into-pinch-in", async (record) => {
      await closeAll();
      await run(`open("ci"); return 0;`);
      const rest = await waitFor((x) => x.phase === "open");
      const close = closeOf(rest);
      record.down = await run(`return ac.shell.devClick("w1", { x: ${close.x}, y: ${close.y}, queued: true, only: "down", wait: 60 });`);
      const pinched = await run(`return stage().then((s) => realSteps(s, [["began", 0], ["changed", -0.3], ["changed", -0.5], ["changed", -0.7]])).then(() => until((x) => x.phase === "gesture" && x.trace.at(-1).alpha <= 0)).then(summary);`);
      record.alpha = pinched.trace.at(-1).alpha;
      record.chrome = pinched.trace.at(-1).chrome;
      record.up = await run(`return ac.shell.devClick("w1", { x: ${close.x}, y: ${close.y}, queued: true, only: "up", wait: 60 });`);
      await sleep(600);
      record.after = { peek: await store(`!!st().peeks.a`) };
      await run(`return stage().then((s) => post(s, "cancelled", 0)).then(() => settle(600));`).catch(() => {});
      assert.equal(record.alpha, 0, "the card had faded out before the release");
      assert.equal(record.after.peek, true, "a Close pressed before the card vanished and released while it was invisible doesn't close the Peek");
    });
    await check("side-press-on-invisible-dim", async (record) => {
      await closeAll();
      await run(`st().updateSettings({ peekButtons: "left" }); return settle(200);`);
      await run(`open("sd"); return 0;`);
      const rest = await waitFor((x) => x.phase === "open");
      const side = rest.chromeTargets?.find((t) => t.surface === "side" && t.label === "Close (Esc)");
      try {
        assert.ok(side?.reaches, `the side Close takes a press at rest: ${JSON.stringify(rest.chromeTargets)}`);
        const pinched = await run(`return stage().then((s) => realSteps(s, [["began", 0], ["changed", -0.3], ["changed", -0.55]])).then(() => until((x) => x.phase === "gesture" && x.trace.at(-1).scrim <= 0)).then(summary);`);
        const hidden = pinched.chromeTargets.find((t) => t.surface === "side" && t.label === side.label);
        Object.assign(record, { scrim: pinched.trace.at(-1).scrim, hidden, published: pinched.published });
        assert.equal(record.scrim, 0, "the dim has faded out");
        assert.equal(hidden?.reaches, false, "no press reaches a side button on an invisible dim");
        assert.equal(pinched.published?.scrimShown, false);
        record.down = await run(`return ac.shell.devClick("w1", { x: ${side.x}, y: ${side.y}, queued: true, only: "down", wait: 60 });`);
        await run(`return stage().then((s) => post(s, "cancelled", 0)).then(() => until((x) => x.phase === "open" && x.trace.at(-1).scrim > 0.5));`);
        record.up = await run(`return ac.shell.devClick("w1", { x: ${side.x}, y: ${side.y}, queued: true, only: "up", wait: 60 });`);
        await sleep(600);
        record.peek = await store(`!!st().peeks.a`);
        assert.equal(record.peek, true, "a press that started on the invisible dim doesn't close the Peek once the dim is back");
      } finally {
        await run(`st().updateSettings({ peekButtons: "top" }); return settle(200);`).catch(() => {});
      }
    });
    await check("chrome-hidden-mid-spread", async (record) => {
      await closeAll();
      await run(`open("cs"); return 0;`);
      await waitFor((x) => x.phase === "open");
      const spread = await run(`return stage().then((s) => realSteps(s, [["began", 0], ["changed", 0.12], ["changed", 0.2], ["changed", 0.26], ["changed", 0.28]])).then(() => until((x) => x.phase === "gesture" && x.trace.at(-1).chrome <= 0)).then(summary);`);
      const close = closeOf(spread);
      Object.assign(record, { chrome: spread.trace.at(-1).chrome, phase: spread.phase, targets: spread.chromeTargets });
      assert.equal(spread.phase, "gesture", "the spread is still held");
      assert.equal(spread.trace.at(-1).chrome, 0, "the bar has faded out");
      assert.ok(close, "the Close button is still laid out");
      assert.deepEqual(spread.chromeTargets.filter((t) => t.surface === "bar" && t.reaches).map((t) => t.label), [], "no invisible bar button takes a press");
      record.click = await pressAt(close);
      await sleep(600);
      record.after = { peek: await store(`!!st().peeks.a`), phase: (await stateOf())?.phase };
      await run(`return stage().then((s) => post(s, "cancelled", 0)).then(() => settle(600));`).catch(() => {});
      assert.equal(record.after.peek, true, "a press where the invisible Close sits leaves the Peek open");
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
