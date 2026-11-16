#!/usr/bin/env node
import { chromium } from "playwright-core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const USAGE = `video-mirror-check.mjs [--out DIR] [--chrome PATH]

Runs the page script's video mirror and the mirror's applier (ios/video_mirror.js) in headless Chrome: a
Netflix-like player at https://www.netflix.com feeds the mirror page batch by batch, and each step compares
the two screenshots (the mirror over black, as the video would show under it). Prints one JSON report and
exits 1 when a step differs or a batch fails. --out keeps the screenshots.`;
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const out = option("--out");
const chrome = option("--chrome") || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
if (!chrome) throw new Error("no Chrome found: pass --chrome PATH");
if (out) mkdirSync(out, { recursive: true });

const ios = new URL("../ios/", import.meta.url);
const script = readFileSync(new URL("page_script.js", ios), "utf8");
const slice = (from, to) => script.slice(script.indexOf(from), script.indexOf(to, script.indexOf(from)));
const block = slice("  const videoMirror = (() => {", "  let bridgesProtectedPlayback = () => false;");
const helpers = slice("  const isTop = ", "  const displayRequests = new Map();");
const applier = readFileSync(new URL("video_mirror.js", ios), "utf8");
const prelude = `(function () { window.__sent = []; const post = (kind, json) => window.__sent.push([kind, json]);
${helpers}${block}window.__mirror = videoMirror; window.__handlers = handlers; })();`;

const player = `<!doctype html><html class="dark" style="--accent: rgb(229, 9, 20)"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://assets.cdn.test/player.css"><style>
html, body { margin: 0; background: #141414; font: 16px/1.2 Helvetica, Arial, sans-serif; color: white; overflow: hidden; }
.watch-video { position: absolute; inset: 0; background: black; }
video { position: absolute; inset: 0; width: 100%; height: 100%; }
.controls { position: absolute; left: 0; right: 0; bottom: 0; padding: 24px 32px; background: linear-gradient(transparent, rgba(0,0,0,0.6)); display: flex; align-items: center; gap: 18px; }
.controls button { width: 48px; height: 48px; border-radius: 24px; border: 2px solid transparent; background: rgba(255,255,255,0.15); color: white; }
.controls button:hover { background: var(--accent); transform: scale(1.2); }
.scrubber { flex: 1; height: 6px; background: rgba(255,255,255,0.3); position: relative; }
.fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); }
.menu { position: absolute; right: 32px; bottom: 100px; background: rgba(38,38,38,0.95); padding: 12px 18px; display: none; }
.menu.open { display: block; }
.subtitles { position: absolute; left: 0; right: 0; bottom: 140px; text-align: center; font-size: 34px; }
x-badge:not(:defined) { display: none; }
</style></head><body><div class="watch-video" data-uia="watch-video"><video muted></video>
<div class="title">Show Title <span class="episode">E1</span></div><div class="subtitles"><span>Where are we going?</span></div>
<ul class="menu" id="menu"><li>English</li><li>Off</li></ul>
<div class="controls"><button id="play"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 4l14 8-14 8z" fill="currentColor"/></svg></button>
<div class="scrubber"><div class="fill" style="width: 10%"></div></div><span class="time">0:00</span><canvas width="40" height="20" id="mini"></canvas>
<x-badge id="badge"></x-badge><x-closed id="closed"></x-closed><button id="subs">CC</button><input type="range" id="volume" value="40"></div></div>
<script>
const root = document.getElementById("closed").attachShadow({ mode: "closed" });
const sheet = new CSSStyleSheet(); sheet.replaceSync(".pill { padding: 4px 8px; border-radius: 10px; background: teal; }");
root.adoptedStyleSheets = [sheet]; root.innerHTML = '<span class="pill">HD</span>';
const c = document.getElementById("mini").getContext("2d"); c.fillStyle = "lime"; c.fillRect(0, 0, 40, 20);
document.getElementById("subs").addEventListener("click", () => document.getElementById("menu").classList.toggle("open"));
let t = 0;
window.tick = () => { t++; document.querySelector(".time").textContent = "0:" + String(t % 60).padStart(2, "0"); document.querySelector(".fill").style.width = 10 + (t % 80) + "%"; };
window.define = () => customElements.define("x-badge", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<b style='color:yellow'>NEW</b>"; } });
</script></body></html>`;

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, bypassCSP: true });
await context.route("https://www.netflix.com/watch/1", (r) => r.fulfill({ contentType: "text/html", body: player }));
await context.route("https://www.netflix.com/mirror", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }));
await context.route("https://assets.cdn.test/player.css", (r) =>
  r.fulfill({ contentType: "text/css", body: ".episode { color: rgb(180,180,180); margin-left: 8px }", headers: { "access-control-allow-origin": "*" } }),
);
const source = await context.newPage();
const mirror = await context.newPage();
const report = { steps: {}, failures: [], errors: [] };
source.on("pageerror", (e) => report.errors.push("page: " + e.message));
mirror.on("pageerror", (e) => report.errors.push("mirror: " + e.message));
await source.addInitScript(prelude);
await source.goto("https://www.netflix.com/watch/1");
await mirror.goto("https://www.netflix.com/mirror");
await mirror.evaluate(applier);

const timings = { page: [], apply: [], bytes: [], maxPartBytes: 0 };
let parts = [];
const pump = async () => {
  for (const [kind, json] of await source.evaluate(() => window.__sent.splice(0))) {
    const m = JSON.parse(json);
    if (kind !== "videoMirror" || m.op !== "part") continue;
    timings.maxPartBytes = Math.max(timings.maxPartBytes, Buffer.byteLength(json));
    if (m.part === 0) parts = [];
    parts.push(m.data);
    if (parts.length < m.parts) continue;
    const text = parts.join("");
    const result = await mirror.evaluate((batch) => window.ardiaVideoMirror(batch), text);
    if (!result.ok) report.failures.push(result.error);
    else timings.page.push(result.pageMs), timings.apply.push(result.ms), timings.bytes.push(text.length);
  }
};
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const settle = async () => {
  for (let i = 0; i < 4; i++) await frames(source), await pump();
  await frames(mirror);
};
const compare = async (name) => {
  await settle();
  const [a, b] = [await source.screenshot(), await mirror.screenshot()];
  if (out) writeFileSync(`${out}/${name}-page.png`, a), writeFileSync(`${out}/${name}-mirror.png`, b);
  const diff = await mirror.evaluate(async ([a64, b64]) => {
    const load = (b) => createImageBitmap(new Blob([Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const canvas = new OffscreenCanvas(ia.width, ia.height);
    const x = canvas.getContext("2d");
    x.drawImage(ia, 0, 0);
    const pa = x.getImageData(0, 0, ia.width, ia.height).data;
    x.clearRect(0, 0, ia.width, ia.height);
    x.drawImage(ib, 0, 0);
    const pb = x.getImageData(0, 0, ia.width, ia.height).data;
    let differing = 0;
    for (let i = 0; i < pa.length; i += 4) if (Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2])) > 24) differing++;
    return { differing, total: pa.length / 4 };
  }, [a.toString("base64"), b.toString("base64")]);
  report.steps[name] = diff;
  if (diff.differing > diff.total * 0.0005) report.failures.push(`${name}: ${diff.differing} pixels differ`);
};

await source.evaluate(() => window.__mirror.start(document.querySelector("video")));
await settle();
await mirror.addStyleTag({ content: "html:root:root { background: black !important }" });
await compare("snapshot");
await source.evaluate(() => { for (let i = 0; i < 7; i++) tick(); });
await compare("ticks");
const play = await source.evaluate(() => { const r = document.getElementById("play").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await source.mouse.move(...play);
await compare("hover");
await source.click("#subs");
await compare("menu");
await source.evaluate(() => window.define());
await compare("defined");
await source.setViewportSize({ width: 1000, height: 600 });
await mirror.setViewportSize({ width: 1000, height: 600 });
await compare("resized");
await source.evaluate(() => {
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:40px;top:80px;width:600px;height:300px;overflow:hidden;font-size:9px";
  for (let i = 0; i < 3000; i++) box.append(Object.assign(document.createElement("span"), { textContent: `item ${i} \u{1F3AC} "q" ` }));
  document.querySelector(".watch-video").append(box);
});
await compare("large");
await mirror.evaluate(() => document.querySelector(".watch-video").remove());
await source.evaluate(() => window.__handlers.videoMirror({ resync: true }));
await compare("resync");
await source.evaluate(() => window.__mirror.stop());
const last = (await source.evaluate(() => window.__sent.map(([, json]) => json))).pop();
if (last !== '{"op":"stop"}') report.failures.push("stop sent no stop message");
const average = (list) => Math.round((list.reduce((a, b) => a + b, 0) / Math.max(list.length, 1)) * 100) / 100;
report.timings = {
  batches: timings.page.length,
  pageMsAvg: average(timings.page),
  pageMsMax: Math.max(...timings.page),
  applyMsAvg: average(timings.apply),
  applyMsMax: Math.max(...timings.apply),
  firstBatchChars: timings.bytes[0],
  maxPartBytes: timings.maxPartBytes,
};
if (report.errors.length) report.failures.push(...report.errors);
console.log(JSON.stringify(report, null, 1));
await browser.close();
process.exit(report.failures.length ? 1 : 0);
