#!/usr/bin/env node
const HELP = `Click to skip in the video Picture in Picture window (issue #1735), end to end in a hidden instance: a click on the
left of the video skips back 10 s, on the right ahead 10 s, the centre column (the play button's) does nothing, a drag
moves the window without seeking (also one that only passes 3 pt at the release), quick repeated clicks skip once each,
the skip moves the video in the window even while it is paused and another one plays, a page's Media Session seek
handlers get the skip as they get Chrome's own button (seekto on the timeline the page reports, kept current through
repeated clicks and a pause though the page reports it once, also for a video in a closed shadow root), a stashed
window never seeks, and Chrome's close button still closes.

  node apps/browser/scripts/pip-click-seek-test.mjs <Debug app> [--out DIR] [--keep] [--expect-no-seek]
  node apps/browser/scripts/pip-click-seek-test.mjs --attach [--out DIR] [--expect-no-seek]

  --out DIR          scratch: the clip, the instance's data, the log (default $TMPDIR/ac-pip-click-seek)
  --keep             leave the instance up; --attach reuses it
  --expect-no-seek   for a build from before #1735: every click check expects the video not to move. Such a build's
                     mouse: dev action takes no click count and no dragged events, so there its repeated clicks
                     are single clicks and its drags plain clicks, and the drag's window move isn't checked

Needs ffmpeg (the clip is made once into DIR/media). Each line says how far the video moved, measured from
video.currentTime against the wall clock while it plays, and how many skips native reported.`;
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { attach, launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    keep: { type: "boolean" },
    attach: { type: "boolean" },
    "expect-no-seek": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
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
const before = !!flags["expect-no-seek"];
const out = resolve(flags.out ?? join(tmpdir(), "ac-pip-click-seek"));
const media = join(out, "media");
const data = join(out, "data");
mkdirSync(media, { recursive: true });

const clip = join(media, "clip.mp4");
if (!existsSync(clip))
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-t", "180",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip], { stdio: "inherit" });
writeFileSync(join(media, "index.html"), `<!doctype html><html><head><title>Seek</title><style>html,body{margin:0;background:#000}</style></head><body>
<video id="v" src="clip.mp4" muted playsinline style="width:640px;height:360px"></video>
<video id="other" src="clip.mp4" muted playsinline preload="auto" style="width:320px;height:180px"></video>
<div id="host"></div>
<script>
const v = document.getElementById("v"), other = document.getElementById("other"), host = document.getElementById("host");
const hidden = Object.assign(document.createElement("video"), { src: "clip.mp4", muted: true, playsInline: true, preload: "auto" });
host.attachShadow({ mode: "closed" }).append(hidden);
let subject = v;
window.ready = new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true })).then(() => { v.currentTime = 60; return v.play(); }).then(() => "ok", (e) => String(e));
window.sample = () => ({ time: subject.currentTime, at: performance.now(), paused: subject.paused, pip: document.pictureInPictureElement === (subject === v ? v : host), otherTime: other.currentTime, otherPaused: other.paused });
window.seekCalls = [];
window.handleSeeks = (names, timelineOffset = 0) => {
  for (const name of ["seekbackward", "seekforward", "seekto"])
    navigator.mediaSession.setActionHandler(name, names.includes(name) ? (d) => {
      seekCalls.push(name);
      subject.currentTime = name === "seekto" ? d.seekTime - timelineOffset : subject.currentTime + (name === "seekforward" ? 1 : -1) * (d.seekOffset || 10);
    } : null);
  if (timelineOffset) navigator.mediaSession.setPositionState({ duration: subject.duration + timelineOffset, position: subject.currentTime + timelineOffset, playbackRate: 1 });
  else navigator.mediaSession.setPositionState();
  seekCalls.length = 0;
  return "ok";
};
window.pausePip = (paused, declared) => (paused ? Promise.resolve(subject.pause()) : subject.play()).then(() => {
  if (declared) navigator.mediaSession.playbackState = paused ? "paused" : "playing";
  return "ok";
}, (e) => String(e));
window.hideInShadowRoot = () => hidden.requestPictureInPicture().then(() => {
  v.pause();
  subject = hidden;
  hidden.currentTime = 60;
  return hidden.play();
}).then(() => "ok", (e) => String(e));
window.playOther = (playing) => (playing ? Promise.resolve(v.pause()).then(() => { other.currentTime = 20; return other.play(); }) : Promise.resolve(other.pause()).then(() => v.play())).then(() => "ok", (e) => String(e));
</script></body></html>`);

const server = await new Promise((r) => {
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
  s.listen(0, "127.0.0.1", () => r(s));
});
const url = `http://127.0.0.1:${server.address().port}/index.html?n=${Date.now()}`;

const r = reporter(join(out, "pip-click-seek.log"), { name: "pip-click-seek" });
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

let tabId, page, size, home;
const ok = await r.check("open the video in Picture in Picture", async () => {
  const windowId = await evalApp(`const s = ac.store.getState(); return Object.values(s.windows).find((w) => w.kind !== "small").id`);
  tabId = await evalApp(`return ac.store.getState().newTab(${JSON.stringify(windowId)}, { url: ${JSON.stringify(url)} })`);
  await evalApp(`ac.actions.switchToTab(${JSON.stringify(tabId)}); return true`);
  page = await until("the page", () => instance.page(url, { timeout: 2000 }));
  await until("the page's script", async () => (await page.eval("typeof window.ready")) === "object");
  const ready = await page.eval("window.ready", { timeout: 15000 });
  if (ready !== "ok") throw new Error(`the video didn't play: ${ready}`);
  const entered = await page.eval("document.getElementById('v').requestPictureInPicture().then(() => 'ok', (e) => String(e))", { userGesture: true });
  if (entered !== "ok") throw new Error(`no PiP: ${entered}`);
  const w = await until("the styled PiP window", shown, 8000);
  const [x, y, width, height] = rect(w.frame);
  size = { width, height };
  home = `{{${x}, ${y}}, {${width}, ${height}}}`;
  await sleep(800);
  return `${width}×${height} at ${x},${y}`;
});

const skipCount = async () => {
  const info = await pip("skip").catch(() => "");
  return info ? JSON.parse(info).count : 0;
};
const skipEvents = async () => (await engine("tabs.devEvents", { tabId })).filter((e) => e.name === "pictureInPictureSkip").length;
const sample = () => page.eval("window.sample()");
const mouse = async (steps) => {
  for (const step of steps) {
    if (step.startsWith("wait:")) await sleep(Number(step.slice(5)));
    else await pip(`mouse:${step}`);
    await sleep(40);
  }
};
const click = (x, y, clicks = 1) =>
  Array.from({ length: clicks }, (_, i) => (i ? [`down:${x},${y}:${i + 1}`, `up:${x},${y}:${i + 1}`] : [`down:${x},${y}`, `up:${x},${y}`])).flat();

async function measure(steps) {
  const frameBefore = (await shown()).frame;
  const [skipsBefore, eventsBefore, a] = [await skipCount(), await skipEvents(), await sample()];
  await mouse(steps);
  await sleep(700);
  const b = await sample();
  const [skipsAfter, eventsAfter] = [await skipCount(), await skipEvents()];
  const frameAfter = (await shown())?.frame ?? "";
  const jump = b.time - a.time - (b.at - a.at) / 1000;
  return { jump, skips: skipsAfter - skipsBefore, events: eventsAfter - eventsBefore, paused: b.paused, pip: b.pip, frameBefore, frameAfter };
}

const fmt = (m) => `moved ${m.jump >= 0 ? "+" : ""}${m.jump.toFixed(1)} s, ${m.skips} skips, ${m.events} events${m.paused ? ", paused" : ""}`;
async function seekCheck(name, steps, expected, extra, { byChrome = false } = {}) {
  const want = before && !byChrome ? 0 : expected;
  let m;
  const t0 = Date.now();
  try {
    m = await measure(steps);
    const wantSkips = before || byChrome ? 0 : Math.abs(expected) / 10;
    const problems = [];
    if (Math.abs(m.jump - want) > 1) problems.push(`expected ${want >= 0 ? "+" : ""}${want} s`);
    if ((!before || byChrome) && (m.skips !== wantSkips || m.events !== wantSkips)) problems.push(`expected ${wantSkips} skips and events`);
    if (m.paused) problems.push("the video paused");
    if (!m.pip) problems.push("the video left Picture in Picture");
    const more = extra ? await extra(m) : null;
    if (more) problems.push(more);
    r.record(`${name}: ${fmt(m)}`, { ms: Date.now() - t0, error: problems.length ? new Error(problems.join("; ")) : null, evidence: m });
  } catch (error) {
    r.record(`${name}${m ? `: ${fmt(m)}` : ""}`, { ms: Date.now() - t0, error });
  }
  await pip(`frame:${home}`);
  await sleep(400);
}

if (ok) {
  const { width: w, height: h } = size;
  const midY = Math.round(h / 2);
  const left = Math.round(w * 0.12), right = Math.round(w * 0.88), centre = Math.round(w / 2);
  await seekCheck("left-zone click", click(left, midY), -10);
  await seekCheck("right-zone click", click(right, midY), 10);
  await seekCheck("dead-band click", click(centre, midY), 0);
  await seekCheck("dead-band edge click (38 pt off centre)", click(centre - 38, midY), 0);
  const pressAndRelease = (x, draggedBy, releasedBy) => [`down:${x},${midY}`, `dragged:${x + draggedBy},${midY}`, `up:${x + releasedBy - (before ? 0 : draggedBy)},${midY}`];
  await seekCheck("left-zone click with a 2 pt wobble", pressAndRelease(left, 2, 2), -10);
  await seekCheck("press, 2 pt drag, release 4 pt from the press", pressAndRelease(left, 2, 4), 0);
  await seekCheck("press-drag-release in the right zone", [`down:${right},${midY}`, `dragged:${right - 30},${midY - 20}`, `up:${right - 30},${midY - 20}`], 0,
    async (m) => {
      if (before) return null;
      const [x0, y0] = rect(m.frameBefore), [x1, y1] = rect(m.frameAfter);
      return Math.abs(x1 - x0 + 30) < 1 && Math.abs(y1 - y0 - 20) < 1 ? null : `the window didn't follow the drag: ${m.frameBefore} → ${m.frameAfter}`;
    });
  const controlsUp = [`moved:${centre},${midY}`, "wait:500"];
  await seekCheck("left-zone click with the controls showing", [...controlsUp, ...click(left, midY)], -10);
  await seekCheck("Chrome's own −10 s button: Chrome seeks, we don't", [...controlsUp, ...click(centre - 76, midY)], -10, null, { byChrome: true });
  await seekCheck("double-click in the right zone", click(right, midY, 2), 20);
  await seekCheck("triple-click in the left zone", click(left, midY, 3), -30);
  await seekCheck("double-click in the dead band", click(centre, midY, 2), 0, async (m) => {
    r.say(`  dead-band double-click went to Chrome: frame ${m.frameBefore} → ${m.frameAfter}`);
    return null;
  });
  await r.check("right-zone click with the PiP video paused and another video playing", async () => {
    if ((await page.eval("window.playOther(true)")) !== "ok") throw new Error("the other video didn't play");
    await sleep(500);
    const a = await sample();
    await mouse(click(right, midY));
    await sleep(700);
    const b = await sample();
    if ((await page.eval("window.playOther(false)")) !== "ok") throw new Error("the PiP video didn't resume");
    await sleep(400);
    const moved = b.time - a.time, otherMoved = b.otherTime - a.otherTime - (b.at - a.at) / 1000;
    const said = `the PiP video moved ${moved >= 0 ? "+" : ""}${moved.toFixed(1)} s, the other ${otherMoved >= 0 ? "+" : ""}${otherMoved.toFixed(1)} s`;
    if (!a.paused || a.otherPaused || !b.pip) throw new Error(`setup: ${JSON.stringify(a)}`);
    if (Math.abs(moved - (before ? 0 : 10)) > 1 || Math.abs(otherMoved) > 1) throw new Error(said);
    return said;
  });
  const handled = async () => (await page.eval("JSON.stringify(window.seekCalls.splice(0))"));
  await page.eval('window.handleSeeks(["seekbackward", "seekforward", "seekto"])');
  await sleep(300);
  await seekCheck("right-zone click on a page with Media Session seek handlers", click(right, midY), 10, async () => {
    const calls = await handled();
    return calls === (before ? "[]" : '["seekforward"]') ? null : `the page's handlers got ${calls}`;
  });
  await seekCheck("Chrome's own −10 s button on that page asks the page's handlers too", [...controlsUp, ...click(centre - 76, midY)], -10, async () => {
    const calls = await handled();
    r.say(`  Chrome's button called ${calls}`);
    return JSON.parse(calls).length === 1 ? null : `the page's handlers got ${calls}`;
  }, { byChrome: true });
  await page.eval('window.handleSeeks(["seekto"])');
  await sleep(300);
  await seekCheck("left-zone click on a page with only a seekto handler", click(left, midY), -10, async () => {
    const calls = await handled();
    return calls === (before ? "[]" : '["seekto"]') ? null : `the page's handler got ${calls}`;
  });
  const seektoOnly = (count) => async () => {
    const calls = await handled(), want = JSON.stringify(Array(before ? 0 : count).fill("seekto"));
    return calls === want ? null : `the page's handlers got ${calls}`;
  };
  const reportedOnce = async (where, declared) => {
    await page.eval('window.handleSeeks(["seekto"], 600)');
    await sleep(2000);
    await seekCheck(`${where}: right-zone click on a seekto page whose timeline runs 600 s ahead, reported once, 2 s ago`, click(right, midY), 10, seektoOnly(1));
    await seekCheck(`${where}: double-click, with no new report between the clicks`, click(right, midY, 2), 20, seektoOnly(2));
    await r.check(`${where}: right-zone click with the video paused after playing on`, async () => {
      if ((await page.eval(`window.pausePip(true, ${declared})`)) !== "ok") throw new Error("the video didn't pause");
      await sleep(400);
      const a = await sample();
      await mouse(click(right, midY));
      await sleep(700);
      const b = await sample();
      if ((await page.eval(`window.pausePip(false, ${declared})`)) !== "ok") throw new Error("the video didn't resume");
      await sleep(400);
      const moved = b.time - a.time, calls = await handled();
      const said = `the paused video moved ${moved >= 0 ? "+" : ""}${moved.toFixed(1)} s, the page's handler got ${calls}`;
      if (!a.paused || !b.pip) throw new Error(`setup: ${JSON.stringify(a)}`);
      if (Math.abs(moved - (before ? 0 : 10)) > 1 || calls !== (before ? "[]" : '["seekto"]')) throw new Error(said);
      return said;
    });
    await seekCheck(`${where}: left-zone click once it plays again`, click(left, midY), -10, seektoOnly(1));
    await page.eval('window.handleSeeks(["seekforward", "seekto"], 600)');
    await sleep(300);
    await seekCheck(`${where}: right-zone click through seekforward`, click(right, midY), 10, async () => {
      const calls = await handled();
      return calls === (before ? "[]" : '["seekforward"]') ? null : `the page's handlers got ${calls}`;
    });
    await seekCheck(`${where}: left-zone click through seekto after that`, click(left, midY), -10, seektoOnly(1));
    await page.eval("window.handleSeeks([])");
    await sleep(300);
  };
  await reportedOnce("video in reach", false);
  await r.check("move Picture in Picture to a video inside a closed shadow root", async () => {
    const entered = await page.eval("window.hideInShadowRoot()", { userGesture: true });
    if (entered !== "ok") throw new Error(`no PiP: ${entered}`);
    await until("the styled PiP window", shown, 8000);
    await sleep(800);
    await pip(`frame:${home}`);
    await sleep(400);
    const s = await sample();
    if (!s.pip || s.paused) throw new Error(`the hidden video: ${JSON.stringify(s)}`);
    return "playing in the window";
  });
  await reportedOnce("video in a closed shadow root", true);
  await pip("stash");
  await sleep(900);
  await seekCheck("click on a stashed window", click(left, midY), 0, async () => (await shown())?.stashed ? null : "the window wasn't stashed");
  await pip("unstash");
  await sleep(900);

  const button = join(data, "pip-button-selftest.json");
  rmSync(button, { force: true });
  await r.check("Chrome's close button still closes", async () => {
    if ((await pip("close")) !== "started") throw new Error("no button self-test");
    const result = await until("the close click", async () => (existsSync(button) ? JSON.parse(readFileSync(button, "utf8")) : null), 10000);
    if (!result.closed) throw new Error(`still open: ${JSON.stringify(result)}`);
    const s = await sample();
    if (s.pip || s.paused) throw new Error(`the page after close: ${JSON.stringify(s)}`);
    return result;
  });
}

const passed = r.summary();
server.close();
if (!flags.keep && !flags.attach) await instance.quit();
process.exit(passed ? 0 : 1);
