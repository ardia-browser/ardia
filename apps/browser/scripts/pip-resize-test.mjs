#!/usr/bin/env node
const HELP = `Resizing the video Picture in Picture window, end to end in a hidden instance. A pinch or a drag on the window's
edge moves a stand-in that mirrors the live video every display frame instead of waiting ~33 ms for Chromium at
each step: a 2 s pinch moves the stand-in on every frame while the real window keeps its size, then the real window
takes the final size and the stand-in goes; two quick pinches share one stand-in; edge and corner drags keep the
aspect ratio and the opposite edge or corner; the real window stays able to take the rest of the gesture under the stand-in; a pinch right after a mouse resize grows the window (it once divided by
a stale zero aspect and crashed); and each gesture sends one pictureInPictureStandIn or pictureInPictureResized event.

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
