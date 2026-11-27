#!/usr/bin/env node
const HELP = `Resizing the video Picture in Picture window, end to end in a hidden instance. A pinch or a drag on the window's
edge moves a stand-in that mirrors the live video every display frame instead of waiting ~33 ms for Chromium at
each step: a 2 s pinch moves the stand-in on every frame while the real window keeps its size, then the real window
takes the final size and the stand-in goes; two quick pinches share one stand-in; edge and corner drags keep the
aspect ratio and the opposite edge or corner; the real window stays able to take the rest of the gesture under the stand-in; a window parked past the screen edge resizes where it is; a pinch right after a mouse resize grows the window (it once divided by
a stale zero aspect and crashed); a pinch over the window resizes it without a click to focus it when macOS hands the
gesture to the browser window, while a pinch beside it is left alone; a pinch whose end never arrives, or that a new
pinch replaces, hands off its stand-in; the other-app pinch path and a queued ⌘-scroll route to the window while Ardia is
in the background (routing only: a real gesture from another app is a manual check); the pinch monitor for other apps
follows the window tucking, untucking, closing and reopening and the zoom setting; an edge drag that starts while a
pinch with no end is pending isn't ended by that pinch's stall deadline; hiding the app drops a pinch's stand-in at
once; and each gesture sends one pictureInPictureStandIn or pictureInPictureResized event.

  node apps/browser/scripts/pip-resize-test.mjs <Debug app> [--out DIR] [--keep]
  node apps/browser/scripts/pip-resize-test.mjs --attach [--out DIR]

  --out DIR   scratch: the clip, the instance's data, the log (default $TMPDIR/ac-pip-resize)
  --keep      leave the instance up; --attach reuses it

Needs ffmpeg (the clip is made once into DIR/media).`;
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { attach, launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, keep: { type: "boolean" }, attach: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}
if (!positionals[0] && !flags.attach) {
  console.error(HELP);
  process.exit(2);
}
const app = positionals[0] ? resolve(positionals[0]) : null;
const out = resolve(flags.out ?? join(tmpdir(), "ac-pip-resize"));
const media = join(out, "media");
const data = join(out, "data");
mkdirSync(media, { recursive: true });

const clip = join(media, "clip.mp4");
const wideClip = join(media, "wide.mp4");
if (!existsSync(wideClip))
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x270:r=30", "-t", "120",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", wideClip], { stdio: "inherit" });
if (!existsSync(clip))
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-t", "120",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip], { stdio: "inherit" });
writeFileSync(join(media, "index.html"), `<!doctype html><html><head><title>Resize</title></head><body style="margin:0;background:#000">
<video id="v" src="clip.mp4" muted playsinline style="width:640px;height:360px"></video>
<script>const v = document.getElementById("v"); window.ready = new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true })).then(() => v.play()).then(() => "ok", (e) => String(e));</script>
</body></html>`);

const server = await new Promise((done) => {
  const s = createServer((req, res) => {
    const path = join(media, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(media) || !existsSync(path)) return res.writeHead(404).end();
    const size = statSync(path).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const headers = { "Content-Type": { ".mp4": "video/mp4", ".html": "text/html" }[extname(path)] ?? "application/octet-stream", "Accept-Ranges": "bytes" };
    if (range) {
      const start = +range[1], end = range[2] ? +range[2] : size - 1;
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": size });
      createReadStream(path).pipe(res);
    }
  });
  s.listen(0, "127.0.0.1", () => done(s));
});
const url = `http://127.0.0.1:${server.address().port}/index.html?n=${Date.now()}`;

const r = reporter(join(out, "pip-resize.log"), { name: "pip-resize" });
let instance;
try {
    instance = flags.attach
      ? attach(data)
      : await launch(app, {
          data, fresh: true, onboarded: true,
          session: session({ tabs: [{ id: "home", url: "about:blank", title: "Home" }] }),
          ready: "return !!globalThis.expo?.modules?.ArdiaEngine && Object.keys(ac.store.getState().windows).length > 0",
        });
  } catch (e) {
    console.log(`FAIL launch: ${e.message}`);
    server.close();
    process.exit(1);
  }

  const evalApp = (body, timeout) => instance.eval(body, { timeout });
  const engine = (name, args = {}) => evalApp(`return ac.engine.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
  const pip = (action) => engine("tabs.devPictureInPictureAction", { action });
  const until = async (what, test, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      const v = await test().catch(() => null);
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const rect = (s) => s.match(/-?[\d.]+/g).map(Number);
  const shown = async () => (await engine("tabs.devPictureInPicture"))?.find((w) => w.video && w.styled && w.visible) ?? null;
  const state = async () => {
    const w = await shown();
    if (!w) return null;
    const [x, y, width, height] = rect(w.frame);
    return { x, y, width, height };
  };
  const size = (s) => `${s.width}x${s.height}`;

  let tabId;
  const eventCount = async (name) => (await engine("tabs.devEvents", { tabId })).filter((e) => e.name === name).length;

  let ok = false;
  try {
  ok = await r.check("open the video in Picture in Picture", async () => {
    const windowId = await evalApp(`const s = ac.store.getState(); return Object.values(s.windows).find((w) => w.kind !== "small").id`);
    tabId = await evalApp(`return ac.store.getState().newTab(${JSON.stringify(windowId)}, { url: ${JSON.stringify(url)} })`);
    await evalApp(`ac.actions.switchToTab(${JSON.stringify(tabId)}); return true`);
    const page = await until("the page", () => instance.page(url, { timeout: 2000 }));
    await until("the page's script", async () => (await page.eval("typeof window.ready")) === "object");
    const ready = await page.eval("window.ready", { timeout: 15000 });
    if (ready !== "ok") throw new Error(`the video didn't play: ${ready}`);
    const entered = await page.eval("document.getElementById('v').requestPictureInPicture().then(() => 'ok', (e) => String(e))", { userGesture: true });
    if (entered !== "ok") throw new Error(`no PiP: ${entered}`);
    await until("the styled PiP window", shown, 8000);
    await pip("alpha:1");
    await sleep(800);
    return size(await state());
  });

  if (ok) {
    await r.check("a 2 s pinch moves the stand-in every frame while the real window waits, then the real window takes its size", async () => {
      const before = await state();
      const events = await eventCount("pictureInPictureStandIn");
      await pip("pinch:1.6,240,120");
      await sleep(500);
      const standIn = await pip("standIn");
      const middle = await state();
      const during = JSON.parse(await pip("pinchStats"));
      await until("the hand-off", async () => !(await pip("standIn")), 5000);
      const stats = JSON.parse(await pip("pinchStats"));
      const after = await state();
      const problems = [];
      if (!standIn) problems.push("no stand-in during the pinch");
      if (middle.width !== before.width) problems.push(`the real window resized mid-pinch (${size(middle)})`);
      if (during.alpha !== Math.min(during.restingAlpha, 0.01)) problems.push(`the real window went to alpha ${during.alpha} under the stand-in, where the rest of the pinch can't reach it`);
      if (stats.alpha !== during.restingAlpha) problems.push(`the real window came back at alpha ${stats.alpha}, not ${during.restingAlpha}`);
      const fps = stats.fps || 60;
      if (stats.applied < fps * 2 * 0.8 || stats.gapMsMedian > (1000 / fps) * 1.5)
        problems.push(`the stand-in moved ${stats.applied} times, median ${stats.gapMsMedian} ms apart, on a ${fps} Hz display`);
      if (after.width < before.width * 1.5) problems.push(`the real window ended at ${size(after)}`);
      if ((await eventCount("pictureInPictureStandIn")) !== events + 1) problems.push("no pictureInPictureStandIn event");
      if (problems.length) throw new Error(problems.join("; "));
      return { before: size(before), after: size(after), fps: stats.fps, applied: stats.applied, gapMsMedian: stats.gapMsMedian, gapMsMax: stats.gapMsMax };
    });

    await r.check("two quick pinches share one stand-in and are counted as two", async () => {
      const events = await eventCount("pictureInPictureStandIn");
      await pip("pinch:1.2,24,120");
      await sleep(120);
      const first = await pip("standIn");
      await sleep(100);
      const stillThere = await pip("standIn");
      if (first && stillThere !== first) throw new Error(`the first stand-in ${first} was gone before the second pinch (${stillThere || "none"})`);
      await pip("pinch:0.85,24,120");
      await sleep(120);
      const second = await pip("standIn");
      await until("the hand-off", async () => !(await pip("standIn")), 5000);
      if (!first || first !== second) throw new Error(`stand-ins ${first} and ${second}`);
      const counted = (await eventCount("pictureInPictureStandIn")) - events;
      if (counted !== 2) throw new Error(`${counted} pictureInPictureStandIn events for two pinches`);
      return { standIn: first, events: counted };
    });

    const s0 = await state();
    const box = await engine("tabs.devPictureInPicture").then((ws) => rect(ws.find((w) => w.video && w.styled && w.visible).visibleFrame));
    await pip(`frame:{{${Math.round(box[0] + box[2] / 2 - 200)}, ${Math.round(box[1] + box[3] / 2 - 112)}}, {400, 225}}`);
    await sleep(800);
    const drag = async (name, at, by, expect) => {
      await r.check(name, async () => {
        const before = await state();
        const events = await eventCount("pictureInPictureResized");
        const [x, y] = at(before);
        await pip(`mouse:down:${x},${y}`);
        await sleep(60);
        const standIn = await pip("standIn");
        for (let i = 1; i <= 12; i++) {
          await pip(`mouse:dragged:${Math.round(x + (by[0] * i) / 12)},${Math.round(y + (by[1] * i) / 12)}`);
          await sleep(16);
        }
        await pip(`mouse:up:${x + by[0]},${y + by[1]}`);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        const after = await state();
        const problems = [];
        if (!standIn) problems.push("no stand-in during the drag");
        const wrong = expect(before, after);
        if (wrong) problems.push(wrong);
        if (Math.abs(after.width / after.height - before.width / before.height) > 0.02) problems.push("the aspect ratio changed");
        if ((await eventCount("pictureInPictureResized")) !== events + 1) problems.push("no pictureInPictureResized event");
        if (problems.length) throw new Error(problems.join("; "));
        return { before: `${before.x},${before.y} ${size(before)}`, after: `${after.x},${after.y} ${size(after)}` };
      });
    };
    await drag("dragging the right edge out 100 pt widens the window and keeps its left edge", (s) => [s.width - 2, Math.round(s.height / 2)], [100, 0],
      (b, a) => (Math.abs(a.width - (b.width + 100)) > 2 ? `width ${a.width}` : Math.abs(a.x - b.x) > 1 ? `left edge moved to ${a.x}` : null));
    await drag("dragging the bottom-left corner in shrinks the window and keeps its top-right corner", (s) => [2, s.height - 2], [80, -40],
      (b, a) => (a.width > b.width - 60 ? `width ${a.width}` : Math.abs(a.x + a.width - (b.x + b.width)) > 1 || Math.abs(a.y + a.height - (b.y + b.height)) > 1 ? "the top-right corner moved" : null));
    await drag("dragging the top-right corner straight left shrinks the window and keeps its bottom-left corner", (s) => [s.width - 2, 2], [-100, 0],
      (b, a) => (a.width > b.width - 60 ? `width ${a.width}` : Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 ? "the bottom-left corner moved" : null));
    await r.check("a corner drag that turns from outward to inward changes size gradually, with no jump where the two directions cross", async () => {
      const before = await state();
      const [x, y] = [2, 2];
      const widths = [];
      await pip(`mouse:down:${x},${y}`);
      await sleep(60);
      const path = [...Array.from({ length: 8 }, (_, i) => [x - (60 * (i + 1)) / 8, y]), ...Array.from({ length: 24 }, (_, i) => [x - 60, y + (180 * (i + 1)) / 24])];
      for (const [px, py] of path) {
        await pip(`mouse:dragged:${Math.round(px)},${Math.round(py)}`);
        await sleep(30);
        widths.push(rect(JSON.parse(await pip("pinchStats")).shown)[2]);
      }
      await pip(`mouse:up:${Math.round(path.at(-1)[0])},${Math.round(path.at(-1)[1])}`);
      await until("the hand-off", async () => !(await pip("standIn")), 5000);
      const steps = widths.slice(1).map((w, i) => Math.abs(w - widths[i]));
      const largest = Math.max(...steps);
      if (largest > 20) throw new Error(`the width jumped ${largest} pt in one step: ${widths.join(" ")}`);
      if (!(Math.max(...widths) > before.width + 20 && widths.at(-1) < Math.max(...widths) - 40)) throw new Error(`it didn't grow then shrink: ${widths.join(" ")}`);
      return `largest step ${largest} pt, ${before.width} -> ${Math.max(...widths)} -> ${widths.at(-1)}`;
    });
    await drag("dragging the top edge up makes the window taller and keeps its bottom edge", (s) => [Math.round(s.width / 2), 2], [0, -60],
      (b, a) => (a.height < b.height + 50 ? `height ${a.height}` : Math.abs(a.y - b.y) > 1 ? `bottom edge moved to ${a.y}` : null));

    await r.check("a window parked past the screen edge is resized where it is, by a pinch or an edge drag, and not pulled back on screen", async () => {
      const [vx, , vw] = await engine("tabs.devPictureInPicture").then((ws) => rect(ws.find((w) => w.video && w.styled && w.visible).visibleFrame));
      const edge = vx + vw;
      const home = await state();
      await pip(`frame:{{${Math.round(edge - home.width * 0.7)}, ${home.y}}, {${home.width}, ${home.height}}}`);
      await sleep(600);
      const parked = await state();
      const right = (s) => s.x + s.width;
      if (right(parked) < edge + parked.width * 0.2) throw new Error(`couldn't park it past the edge: ${JSON.stringify(parked)}`);
      try {
        await pip("pinch:1.3,300,120");
        await sleep(150);
        const standIn = Number(await pip("standIn"));
        const covered = execFileSync("/usr/bin/swift", ["-e", `import CoreGraphics; let l = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]; if let w = l.first(where: { ($0[kCGWindowNumber as String] as? Int) == ${standIn} }), let b = w[kCGWindowBounds as String] as? [String: Double] { print(b["X"]!, b["Width"]!) }`]).toString().trim().split(" ").map(Number);
        if (covered.length !== 2 || covered[0] > parked.x + 1 || covered[0] + covered[1] < right(parked) - 1)
          throw new Error(`the stand-in spans ${covered[0]}..${covered[0] + covered[1]} and the window ${parked.x}..${right(parked)}: the part past the edge has no stand-in`);
        await sleep(400);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        const grown = await state();
        if (grown.width <= parked.width + 20) throw new Error(`the pinch didn't grow it: ${size(grown)}`);
        if (Math.abs(right(grown) - right(parked)) > 1) throw new Error(`growing moved its hidden edge from ${right(parked)} to ${right(grown)} (the screen ends at ${edge})`);
        await pip("pinch:0.8,24,120");
        await sleep(400);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        const shrunk = await state();
        if (shrunk.width >= grown.width - 20) throw new Error(`the pinch didn't shrink it: ${size(shrunk)}`);
        if (right(shrunk) <= edge + 1 || right(shrunk) > right(grown) + 1 || shrunk.x < grown.x - 1) throw new Error(`shrinking moved it to ${shrunk.x}..${right(shrunk)} from ${grown.x}..${right(grown)} (the screen ends at ${edge})`);
        const y = Math.round(shrunk.height / 2);
        await pip(`mouse:down:2,${y}`);
        await sleep(60);
        for (let i = 1; i <= 8; i++) {
          await pip(`mouse:dragged:${Math.round(2 - (60 * i) / 8)},${y}`);
          await sleep(16);
        }
        await pip(`mouse:up:-58,${y}`);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        const dragged = await state();
        if (dragged.width <= shrunk.width + 20) throw new Error(`the edge drag didn't widen it: ${size(dragged)}`);
        if (Math.abs(right(dragged) - right(shrunk)) > 1) throw new Error(`the edge drag moved its hidden edge from ${right(shrunk)} to ${right(dragged)}`);
        return { edge, parked: `${parked.x}..${right(parked)}`, grown: `${grown.x}..${right(grown)}`, shrunk: `${shrunk.x}..${right(shrunk)}`, dragged: `${dragged.x}..${right(dragged)}` };
      } finally {
        await pip(`frame:{{${home.x}, ${home.y}}, {${home.width}, ${home.height}}}`);
        await sleep(600);
      }
    });
    await r.check("shrinking a window parked past the edge by its visible edge leaves it where it is, not tucked away", async () => {
      const [vx, , vw] = await engine("tabs.devPictureInPicture").then((ws) => rect(ws.find((w) => w.video && w.styled && w.visible).visibleFrame));
      const edge = vx + vw;
      const home = await state();
      await pip(`frame:{{${Math.round(edge - home.width * 0.6)}, ${home.y}}, {${home.width}, ${home.height}}}`);
      await sleep(600);
      const parked = await state();
      const hidden = (s) => s.x + s.width - edge;
      if (hidden(parked) < parked.width * 0.3 || (await shown()).stashed) throw new Error(`couldn't park it past the edge: ${JSON.stringify(parked)}`);
      try {
        const y = Math.round(parked.height / 2), by = Math.round(parked.width * 0.3);
        await pip(`mouse:down:2,${y}`);
        await sleep(60);
        for (let i = 1; i <= 8; i++) {
          await pip(`mouse:dragged:${Math.round(2 + (by * i) / 8)},${y}`);
          await sleep(16);
        }
        await pip(`mouse:up:${2 + by},${y}`);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        await sleep(900);
        const after = await state(), tucked = (await shown()).stashed;
        if (after.width >= parked.width - 20) throw new Error(`the drag didn't shrink it: ${size(after)}`);
        if (tucked) throw new Error(`it was tucked away at the edge (stashed ${tucked}) with ${hidden(after)} of ${after.width} pt past the edge`);
        if (hidden(after) > after.width / 2 + 1) throw new Error(`${hidden(after)} of ${after.width} pt is past the edge, more than half`);
        return { parked: `${hidden(parked)} of ${parked.width} pt hidden`, after: `${hidden(after)} of ${after.width} pt hidden` };
      } finally {
        if ((await shown())?.stashed) await pip("unstash");
        await sleep(400);
        await pip(`frame:{{${home.x}, ${home.y}}, {${home.width}, ${home.height}}}`);
        await sleep(600);
      }
    });
    await r.check("a pinch right after a mouse resize grows the window with its aspect ratio", async () => {
      const before = await state();
      await pip("pinch:1.3,60,120");
      await until("the hand-off", async () => !(await pip("standIn")), 5000);
      const after = await state();
      if (!after || after.width < before.width * 1.2) throw new Error(`the window ended at ${after && size(after)}`);
      if (Math.abs(after.width / after.height - before.width / before.height) > 0.02) throw new Error("the aspect ratio changed");
      return { before: size(before), after: size(after), start: size(s0) };
    });
  }

  if (ok) {
    const appActive = async (on) => {
      const native = (await engine("windows.list"))[0]?.window;
      const answer = await engine("windows.dev", { window: native, action: `fakeAppActive:${on ? 1 : 0}` });
      if (answer !== (on ? "1" : "0")) throw new Error(`fakeAppActive: ${JSON.stringify(answer)}`);
    };
    const standInFlags = async () => (await engine("tabs.devEvents", { tabId })).filter((e) => e.name === "pictureInPictureStandIn").map((e) => e.payload ?? e);
    const activationEvents = async () => (await engine("tabs.devEvents", { tabId })).filter((e) => e.name === "pictureInPictureActivated");
    const activations = async () => (await activationEvents()).length;
    const whileHittable = async (send, delivered) => {
      if ((await pip("hittable:1")) !== "1") throw new Error("couldn't make the window hittable");
      try {
        const answer = await send();
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && !(await delivered())) await sleep(50);
        return answer;
      } finally {
        await pip("hittable:0");
      }
    };
    const magnify = async (args) => {
      const parts = args.split(",");
      const expected = 1 + Number(parts[3]) + (parts[5] === "noEnd" ? 0 : 1);
      const seen = (await lastPinch()).events;
      return whileHittable(async () => JSON.parse(await pip(`magnify:${args}`)), async () => (await lastPinch()).events >= seen + expected);
    };
    const lastPinch = async () => JSON.parse(await pip("lastPinch"));
    const monitor = async () => (await engine("tabs.devPictureInPictureAction", { action: "pinchMonitor" })) === "1";
    const handOff = async () => {
      await sleep(300);
      await until("the hand-off", async () => !(await pip("standIn")), 5000);
      await sleep(300);
    };
    const middle = (s) => `${Math.round(s.width / 2)},${Math.round(s.height / 2)}`;
    const invisible = async () => {
      await pip("alpha:0");
      await pip("hittable:0");
    };
    await invisible();
    try {
      await r.check("routing: a pinch macOS hands to the browser window, seen by the monitor with that window, resizes the PiP under the pointer; one beside it passes through", async () => {
        await appActive(true);
        const before = await state();
        const count = (await standInFlags()).length;
        const over = await magnify(`${middle(before)},1.3,24,main`);
        await handOff();
        const seenOver = await lastPinch();
        const grown = await state();
        const beside = await magnify(`-80,${Math.round(grown.height / 2)},1.3,24,main`);
        await sleep(900);
        const seenBeside = await lastPinch();
        const after = await state();
        const flags = await standInFlags();
        const problems = [];
        if (!seenOver.eventWindow || seenOver.eventWindow !== over.browser || seenOver.eventWindow === over.pip) problems.push(`the monitor saw the pinch on window ${seenOver.eventWindow}, not the browser window ${over.browser}`);
        if (seenOver.routedTo !== over.pip || !seenOver.consumed || seenOver.fromOtherApp) problems.push(`the pinch over it went to ${JSON.stringify(seenOver)}`);
        if (over.under !== over.pip) problems.push(`the pointer's window was ${over.under}, not the PiP ${over.pip} (topmost ${over.topmost})`);
        if (grown.width < before.width * 1.2) problems.push(`the pinch over it left it ${size(grown)}`);
        if (seenBeside.eventWindow !== over.browser || seenBeside.routedTo || seenBeside.consumed) problems.push(`the pinch beside it went to ${JSON.stringify(seenBeside)}`);
        if (after.width !== grown.width) problems.push(`the pinch beside it resized it to ${size(after)}`);
        if (flags.length !== count + 1) problems.push(`${flags.length - count} pictureInPictureStandIn events for one pinch over it`);
        else if (!flags.at(-1).unfocused || flags.at(-1).fromOtherApp) problems.push(`it was reported as ${JSON.stringify(flags.at(-1))}`);
        if (problems.length) throw new Error(problems.join("; "));
        return { before: size(before), grown: size(grown), seenOn: seenOver.eventWindow, beside: beside.topmost };
      });
      await r.check("a pinch whose end never arrives hands off within the stall deadline, and a pinch beside the window hands off the one before it", async () => {
        const before = await state();
        await magnify(`${middle(before)},1.2,12,main,noEnd`);
        await sleep(200);
        const during = await pip("standIn");
        await until("the stalled pinch's hand-off", async () => !(await pip("standIn")), 3000);
        const stalled = await lastPinch();
        const afterStall = await state();
        await magnify(`${middle(afterStall)},0.85,12,main,noEnd`);
        await sleep(200);
        const second = await pip("standIn");
        const replacedAt = Date.now();
        await magnify(`-80,${Math.round(afterStall.height / 2)},1.3,12,main`);
        await until("the replaced pinch's hand-off", async () => !(await pip("standIn")), 900);
        const replacedIn = Date.now() - replacedAt;
        const after = await state();
        const problems = [];
        if (!during) problems.push("no stand-in during the pinch with no end");
        if (!stalled.stalled || stalled.stallTimer) problems.push(`the lock after the stall: ${JSON.stringify(stalled)}`);
        if (afterStall.width <= before.width) problems.push(`the stalled pinch didn't keep its size: ${size(afterStall)}`);
        if (!second) problems.push("no stand-in for the second pinch");
        if (after.width >= afterStall.width) problems.push(`the replaced pinch didn't keep its size: ${size(after)}`);
        if (problems.length) throw new Error(problems.join("; "));
        return { before: size(before), stalled: size(afterStall), replaced: size(after), replacedInMs: replacedIn };
      });
      await r.check("routing: the other-app pinch path resizes the PiP and an NSApp-queued ⌘-scroll zooms it while Ardia is in the background, without asking to activate (a real background gesture is a manual check)", async () => {
        await appActive(false);
        try {
          await sleep(300);
          const before = await state();
          const count = (await standInFlags()).length;
          const asked = await activations();
          const pinched = await magnify(`${middle(before)},0.8,24,otherApp`);
          await handOff();
          const seen = await lastPinch();
          const shrunk = await state();
          const widthBefore = (await state()).width;
          await whileHittable(() => pip("swipe:0,60,10,command"), async () => (await state()).width !== widthBefore);
          await sleep(900);
          const scrolled = await state();
          const flags = await standInFlags();
          const problems = [];
          if (!pinched.followsOtherApps) problems.push("no pinch monitor for other apps while Ardia was in the background");
          if (!seen.fromOtherApp || seen.routedTo !== pinched.pip || seen.eventWindow) problems.push(`the other-app pinch went to ${JSON.stringify(seen)}`);
          if (shrunk.width > before.width * 0.9) problems.push(`the pinch left it ${size(shrunk)}`);
          if (scrolled.width <= shrunk.width) problems.push(`⌘-scroll left it ${size(scrolled)}`);
          if (flags.length !== count + 1 || !flags.at(-1).fromOtherApp) problems.push(`stand-in events ${JSON.stringify(flags.slice(count))}`);
          const extra = (await activationEvents()).slice(asked).map((e) => e.payload ?? e);
          if (extra.length) problems.push(`it asked to activate Ardia: ${JSON.stringify(extra)}`);
          if (problems.length) throw new Error(problems.join("; "));
          return { before: size(before), pinched: size(shrunk), scrolled: size(scrolled) };
        } finally {
          await appActive(true).catch(() => null);
        }
      });
      await r.check("with Ardia active again the pinch monitor for other apps is gone", async () => {
        const before = await state();
        const routed = await magnify(`${middle(before)},1.3,24,otherApp`);
        await sleep(900);
        const after = await state();
        if (routed.followsOtherApps) throw new Error("the monitor stayed on");
        if (after.width !== before.width) throw new Error(`a pinch from another app resized it to ${size(after)} while Ardia was active`);
        return size(after);
      });
      await r.check("an edge drag that starts while a pinch with no end is pending keeps the pinch's size and keeps going past the pinch's stall deadline", async () => {
        const area = rect((await shown()).visibleFrame);
        await pip(`frame:{{${Math.round(area[0] + area[2] / 2 - 240)}, ${Math.round(area[1] + area[3] / 2 - 135)}}, {480, 270}}`);
        await sleep(800);
        const before = await state();
        const seenBefore = (await lastPinch()).events;
        await magnify(`${middle(before)},1.1,12,main,noEnd`);
        await until("the pinch's events", async () => (await lastPinch()).events >= seenBefore + 13, 3000);
        const x = before.width - 2, y = Math.round(before.height / 2);
        const pressed = { x: before.x + x, y: before.y + before.height - y };
        await pip(`mouse:down:${x},${y}`);
        await sleep(60);
        const handedTo = await lastPinch();
        const start = await state();
        const local = (screenX, screenY) => `${Math.round(screenX - start.x)},${Math.round(start.y + start.height - screenY)}`;
        const by = 120, moves = 16;
        let midDrag = null;
        for (let i = 1; i <= moves; i++) {
          await pip(`mouse:dragged:${local(pressed.x + (by * i) / moves, pressed.y)}`);
          await sleep(100);
          if (i === 14) midDrag = { standIn: await pip("standIn"), shown: rect(JSON.parse(await pip("pinchStats")).shown)[2] };
        }
        await pip(`mouse:up:${local(pressed.x + by, pressed.y)}`);
        await until("the edge drag's hand-off", async () => !(await pip("standIn")), 5000);
        const after = await state();
        const problems = [];
        if (handedTo.locked) problems.push(`the pinch kept window ${handedTo.locked} after the edge drag began`);
        if (!midDrag?.standIn) problems.push("the edge drag's stand-in was gone 1.4 s in, after the pinch's stall deadline");
        if (start.width <= before.width + 20) problems.push(`the pending pinch was dropped, not finished: ${size(before)} became ${size(start)} at the press`);
        if (Math.abs(after.width - (start.width + by)) > 2) problems.push(`the edge drag left it ${size(after)}, expected width ${start.width + by} (${by} pt of pointer travel in screen space)`);
        if (problems.length) throw new Error(problems.join("; "));
        return { before: size(before), pinched: size(start), after: size(after), midDragWidth: midDrag.shown };
      });
      await r.check("a new pinch that starts inside a pending pinch's stand-in, outside the window's old frame, takes the window", async () => {
        const before = await state();
        const seenBefore = (await lastPinch()).events;
        await magnify(`${middle(before)},1.3,12,main,noEnd`);
        await until("the pinch's events", async () => (await lastPinch()).events >= seenBefore + 13, 3000);
        const grownTo = rect(JSON.parse(await pip("pinchStats")).shown);
        const x = before.width + 30, y = Math.round(before.height / 2);
        if (grownTo[2] < before.width + 70) throw new Error(`inconclusive: the stand-in only reached ${grownTo[2]} pt`);
        const routed = await magnify(`${x},${y},1.05,8,main`);
        await handOff();
        const seen = await lastPinch();
        const after = await state();
        const problems = [];
        const candidate = routed.windows?.find((w) => w.number === routed.pip);
        if (!candidate?.standIn || !candidate.standInClear) problems.push(`the hit test didn't see an uncovered stand-in: ${JSON.stringify(routed.windows)}`);
        else if (rect(candidate.frame)[0] + rect(candidate.frame)[2] > rect(routed.pointer)[0]) problems.push("inconclusive: the pointer was over the old frame");
        if (seen.routedTo !== routed.pip || !seen.consumed) problems.push(`the new pinch went to ${JSON.stringify(seen)}`);
        if (after.width <= before.width + 40) problems.push(`it ended at ${size(after)}`);
        if (problems.length) throw new Error(problems.join("; "));
        return { before: size(before), standIn: grownTo[2], after: size(after) };
      });
      await r.check("hiding the app takes a pinch's stand-in away at once, without waiting for the display link", async () => {
        const before = await state();
        await magnify(`${middle(before)},1.1,12,main,noEnd`);
        await sleep(200);
        const during = await pip("standIn");
        await engine("tabs.devPictureInPictureAction", { action: "appHidden" });
        await sleep(80);
        const after = await pip("standIn");
        const lock = await lastPinch();
        await sleep(400);
        if (!during) throw new Error("no stand-in during the pinch");
        if (after) throw new Error(`the stand-in ${after} was still up after the app hid`);
        if (lock.locked) throw new Error(`the pinch still held window ${lock.locked}`);
        return { standIn: during };
      });
      await r.check("in the background, turning the pinch-to-zoom setting off removes the pinch monitor for other apps and turning it on brings it back", async () => {
        const steps = {};
        await appActive(false);
        try {
          await sleep(300);
          steps.on = await monitor();
          steps.offSetting = await engine("tabs.devPictureInPictureAction", { action: "zoomSetting:0" });
          await sleep(200);
          steps.off = await monitor();
        } finally {
          steps.backSetting = await engine("tabs.devPictureInPictureAction", { action: "zoomSetting:default" });
          await sleep(200);
          steps.back = await monitor();
          await appActive(true).catch(() => null);
        }
        const expected = { on: true, offSetting: "0", off: false, backSetting: "1", back: true };
        if (JSON.stringify(steps) !== JSON.stringify(expected)) throw new Error(`steps ${JSON.stringify(steps)}, expected ${JSON.stringify(expected)}`);
        return steps;
      });
      await r.check("in the background, the pinch monitor for other apps goes when the window tucks or closes and comes back when it untucks or reopens", async () => {
        const page = await instance.page(url, { timeout: 5000 });
        const steps = {};
        await appActive(false);
        try {
          await sleep(300);
          steps.shown = await monitor();
          await pip("stash");
          await sleep(500);
          steps.tucked = await monitor();
          await pip("unstash");
          await sleep(700);
          steps.untucked = await monitor();
          await page.eval("document.exitPictureInPicture().then(() => 'ok', (e) => String(e))");
          await until("the window to close", async () => !(await shown()), 3000);
          await sleep(600);
          steps.closed = await monitor();
          const entered = await page.eval("document.getElementById('v').requestPictureInPicture().then(() => 'ok', (e) => String(e))", { userGesture: true });
          if (entered !== "ok") throw new Error(`no PiP again: ${entered}`);
          await until("the styled PiP window", shown, 8000);
          await sleep(500);
          steps.reopened = await monitor();
        } finally {
          await appActive(true).catch(() => null);
          await invisible().catch(() => null);
        }
        const expected = { shown: true, tucked: false, untucked: true, closed: false, reopened: true };
        if (JSON.stringify(steps) !== JSON.stringify(expected)) throw new Error(`monitor ${JSON.stringify(steps)}, expected ${JSON.stringify(expected)}`);
        return steps;
      });
    } finally {
      await pip("hittable:0").catch(() => null);
      await pip("alpha:1").catch(() => null);
      await sleep(400);
    }
  }

  if (ok) {
    await r.check("a press or a two-finger move on the window while another app is active asks for Ardia to become active with only that window in front", async () => {
      const asked = async () => (await engine("tabs.devEvents", { tabId })).filter((e) => e.name === "pictureInPictureActivated");
      const appActive = async (on) => {
        const native = (await engine("windows.list"))[0]?.window;
        const answer = await engine("windows.dev", { window: native, action: `fakeAppActive:${on ? 1 : 0}` });
        if (answer !== (on ? "1" : "0")) throw new Error(`fakeAppActive: ${JSON.stringify(answer)}`);
      };
      await appActive(true);
      const whileActive = (await asked()).length;
      const s0 = await state();
      await pip(`mouse:down:${Math.round(s0.width / 2)},${Math.round(s0.height / 2)}`);
      await pip(`mouse:up:${Math.round(s0.width / 2)},${Math.round(s0.height / 2)}`);
      await sleep(400);
      if ((await asked()).length !== whileActive) throw new Error("a press asked for activation while Ardia was already active");
      await appActive(false);
      try {
      const before = (await asked()).length;
      const s = await state();
      const [x, y] = [Math.round(s.width / 2), Math.round(s.height / 2)];
      await pip(`mouse:down:${x},${y}`);
      await pip(`mouse:up:${x},${y}`);
      const pressed = await until("the press's event", async () => ((await asked()).length > before ? asked() : null), 3000);
      await pip("swipe:30,0,6");
      const moved = await until("the move's event", async () => ((await asked()).length > before + 1 ? asked() : null), 3000);
      const flags = (e) => `${e.payload?.move ?? e.move}`;
      if (flags(pressed.at(-1)) !== "false") throw new Error(`the press reported move ${flags(pressed.at(-1))}`);
      if (flags(moved.at(-1)) !== "true") throw new Error(`the move reported move ${flags(moved.at(-1))}`);
      return `${(await asked()).length - before} events`;
      } finally {
        await appActive(true).catch(() => null);
        await sleep(900);
      }
    });
    await r.check("a pinch after the video changed shape keeps the window at the video's new shape", async () => {
      const page = await instance.page(url, { timeout: 5000 });
      const play = (src) => page.eval(`(async () => { const v = document.getElementById("v"); v.src = ${JSON.stringify(src)}; await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true })); await v.play(); return v.videoWidth / v.videoHeight; })()`, { timeout: 15000 });
      const ratio = (s) => s.width / s.height;
      await pip("pinch:1.5,24,120");
      await until("the hand-off", async () => !(await pip("standIn")), 5000);
      await sleep(400);
      const before = await state();
      try {
        const wide = await play("wide.mp4");
        const reshaped = await until("Chromium to give the window the new shape", async () => { const s = await state(); return s && Math.abs(ratio(s) - wide) < 0.05 ? s : null; }, 8000);
        if (Math.abs(reshaped.width - before.width) > 1) throw new Error(`inconclusive: Chromium changed the width too (${before.width} to ${reshaped.width}), so the stale ratio would be dropped anyway`);
        await pip("pinch:1.15,24,120");
        await sleep(400);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        await sleep(400);
        const pinched = await state();
        if (pinched.width <= reshaped.width + 10) throw new Error(`the pinch didn't grow it: ${size(pinched)}`);
        if (Math.abs(ratio(pinched) - wide) > 0.05) throw new Error(`the pinch left it ${size(pinched)}, ratio ${ratio(pinched).toFixed(2)}; the video is ${wide.toFixed(2)} and the window was ${ratio(before).toFixed(2)} before the change`);
        return { before: size(before), reshaped: size(reshaped), pinched: size(pinched), video: wide.toFixed(2) };
      } finally {
        await play("clip.mp4").catch(() => null);
        await sleep(1500);
      }
    });
    await r.check("a pinch that starts right after a swipe ends isn't interrupted by the swipe's release", async () => {
      const lastSwipe = async () => JSON.stringify(JSON.parse(await pip("throw")).lastSwipe);
      const settle = async () => {
        await sleep(400);
        await until("the hand-off", async () => !(await pip("standIn")), 5000);
        await sleep(600);
      };
      const before = await lastSwipe();
      await pip("swipe:-40,30,10");
      await sleep(900);
      const alone = await lastSwipe();
      if (alone === before) throw new Error("inconclusive: a slow swipe with nothing after it recorded no release");
      const tries = [];
      for (let i = 0; i < 3; i++) {
        const was = await lastSwipe(), releases = await eventCount("pictureInPictureReleased");
        const swiped = pip("swipe:40,-30,10");
        await sleep(110);
        await Promise.all([swiped, pip("pinch:1.1,12,120")]);
        await settle();
        tries.push((await lastSwipe()) === was ? "left alone" : "released");
        if (tries.at(-1) === "left alone") {
          const counted = (await eventCount("pictureInPictureReleased")) - releases;
          if (counted !== 1) throw new Error(`the swipe the pinch cut short was counted ${counted} times, not once`);
          return { tries };
        }
      }
      throw new Error(`the swipe's release ran under the pinch every time: ${tries.join(", ")}`);
    });
    await r.check("closing Picture in Picture in the middle of a pinch takes the stand-in away", async () => {
      await pip("pinch:1.5,240,120");
      await sleep(400);
      const standIn = await pip("standIn");
      if (!standIn) throw new Error("no stand-in during the pinch");
      const page = await instance.page(url, { timeout: 5000 });
      await page.eval("document.exitPictureInPicture().then(() => 'ok', (e) => String(e))");
      await sleep(1500);
      const panels = await engine("tabs.devPictureInPicture");
      const left = execFileSync("sh", ["-c", `/usr/bin/swift -e 'import CoreGraphics; let l = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]; print(l.contains { ($0[kCGWindowNumber as String] as? Int) == ${Number(standIn)} && (($0[kCGWindowIsOnscreen as String] as? Bool) ?? false) })' 2>/dev/null || echo unknown`]).toString().trim();
      if (left !== "false") throw new Error(`the stand-in window ${standIn} is still on screen (${left})`);
      return { standIn, pipWindows: panels?.length ?? 0 };
    });
    await r.check("a press that asked for activation is still reported when the window closes before the report", async () => {
      const page = await instance.page(url, { timeout: 5000 });
      const entered = await page.eval("document.getElementById('v').requestPictureInPicture().then(() => 'ok', (e) => String(e))", { userGesture: true });
      if (entered !== "ok") throw new Error(`no PiP: ${entered}`);
      await until("the styled PiP window", shown, 8000);
      const asked = async () => (await engine("tabs.devEvents", { tabId })).filter((e) => e.name === "pictureInPictureActivated").length;
      const native = (await engine("windows.list"))[0]?.window;
      await engine("windows.dev", { window: native, action: "fakeAppActive:0" });
      try {
        const before = await asked();
        const s = await state();
        await pip(`mouse:down:${Math.round(s.width / 2)},${Math.round(s.height / 2)}`);
        await pip(`mouse:up:${Math.round(s.width / 2)},${Math.round(s.height / 2)}`);
        await page.eval("document.exitPictureInPicture().then(() => 'ok', (e) => String(e))");
        await until("the window to close", async () => !(await shown()), 1200);
        if ((await asked()) !== before) throw new Error("inconclusive: the report came before the window had closed");
        await until("the report after the close", async () => (await asked()) > before, 4000);
        await sleep(400);
        const reported = (await asked()) - before;
        if (reported !== 1) throw new Error(`${reported} reports for one press`);
        return "the window closed first, then 1 report";
      } finally {
        await engine("windows.dev", { window: native, action: "fakeAppActive:1" }).catch(() => null);
      }
    });
  }

} catch (error) {
  r.record("the run", { error });
} finally {
  server.close();
  if (!flags.keep && !flags.attach) await instance.quit().catch(() => {});
}
const passed = r.summary();
process.exit(passed ? 0 : 1);
