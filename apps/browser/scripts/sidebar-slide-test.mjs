import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node sidebar-slide-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--trials=<n>] [--keep-data]\n\nClosing a sidebar tab leaves no blank space: the rows below slide up, every slide rests at 0, and the sidebar looks the same before and after every row renders again. Also when the list updates while the slides are still running later than they should have finished, as after a close that kept the app busy, and when a row renders just as its slide ends (both left a row one place down, with a blank space above it).");
  process.exit(2);
}
const appPath = resolve(appArg);
const port = args.find((a) => a.startsWith("--port="))?.slice(7);
const trials = Number(args.find((a) => a.startsWith("--trials="))?.slice(9) ?? 3);
const keep = args.includes("--keep-data");
const scratch = mkdtempSync(join(tmpdir(), "ac-sidebar-slide-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "sidebar-slide-test.log"), { name: "sidebar-slide-test" });

const server = createServer((req, res) => {
  const name = req.url.slice(1) || "root";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${name.toUpperCase()}</title><link rel="icon" href="data:,"><body style="font:40px sans-serif">${name}</body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = (name) => `http://127.0.0.1:${server.address().port}/${name}`;
const ROWS = 10;
const WINDOW_WIDTH = 1280;
const SIDEBAR = { left: 0, right: 160, top: 44 };
const fixture = session({
  windows: [{ id: "w1", frame: [80, 80, WINDOW_WIDTH, 800], activeTabIds: { default: "t0" } }],
  tabs: Array.from({ length: ROWS }, (_, i) => ({ id: `t${i}`, url: url(`t${i}`), title: `T${i}` })),
});

function readPng(path) {
  const buf = readFileSync(path);
  let width = 0, height = 0, channels = 4;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(at + 8);
      height = buf.readUInt32BE(at + 12);
      assert.equal(buf[at + 16], 8, "8-bit");
      channels = { 2: 3, 6: 4 }[buf[at + 17]];
    } else if (type === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y ? data[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? data[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      data[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width, height, channels, data };
}

function sidebarPixelsMoved(before, after) {
  const [a, b] = [before, after].map(readPng);
  assert.deepEqual([a.width, a.height], [b.width, b.height], "both snapshots have one size");
  const scale = Math.round(a.width / WINDOW_WIDTH);
  const light = (png, i) => 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  let moved = 0;
  for (let y = SIDEBAR.top * scale; y < a.height; y++)
    for (let x = SIDEBAR.left * scale; x < SIDEBAR.right * scale; x++) {
      const i = (y * a.width + x) * a.channels;
      if (Math.abs(light(a, i) - light(b, i)) > 24) moved++;
    }
  return moved;
}

let app = null;
let shots = 0;
const HELPERS = `
const st = () => ac.store.getState();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const slides = () => [...globalThis.sidebarMotion.w1.slides.values()];
const open = () => st().windows.w1.tabIds.filter((id) => st().tabs[id]);
const refill = () => {
  const missing = ${ROWS} - open().length;
  if (missing <= 0) return Promise.resolve();
  return Promise.resolve(ac.actions.openUrls(Array.from({ length: missing }, (_, i) => ${JSON.stringify(url("more"))} + i))).then(() => settle(1200));
};
const updateList = () => st().updateSettings({ showClearButton: !st().settings.showClearButton });
const showEach = (last) => open().reduce((p, id) => p.then(() => { st().activate(id); return settle(80); }), Promise.resolve()).then(() => { st().activate(last); return settle(500); });
const rest = () => slides().filter((s) => s.value.__getValue() !== 0 || !s.landed).map((s) => ({ offset: s.value.__getValue(), landed: s.landed }));
const snap = (path) => ac.shell.devSnapshotWindow("w1", path).then((ok) => { if (!ok) throw new Error("no snapshot of the window"); });
const drawnThenRendered = (shown, before, after) => snap(before).then(() => showEach(shown)).then(() => snap(after));
const start = () => ac.shell.devSetPointer("w1", { x: 900, y: 600 }).then(refill).then(() => showEach(open()[0]));
`;
const run = (body) => app.eval(`${HELPERS}\n${body}`, { timeout: 40000 });

async function scenario(body) {
  const before = join(scratch, `shot-${++shots}-drawn.png`);
  const after = join(scratch, `shot-${shots}-rendered.png`);
  const result = await run(`const BEFORE = ${JSON.stringify(before)}, AFTER = ${JSON.stringify(after)};\n${body}`);
  const moved = sidebarPixelsMoved(before, after);
  if (!keep) for (const shot of [before, after]) rmSync(shot);
  return { ...result, moved };
}

const closeAndRest = () => scenario(`
  return start().then(() => {
    st().closeTab(open()[2]);
    return settle(900);
  }).then(() => drawnThenRendered(open()[0], BEFORE, AFTER)).then(() => ({ slid: slides().length, rest: rest() }));
`);

const closeWithLateSlides = () => scenario(`
  return start().then(() => {
    st().closeTab(open()[3]);
    return settle(40);
  }).then(() => {
    const running = slides().filter((s) => s.until && !s.landed);
    for (const s of running) s.until = Date.now() - 1;
    updateList();
    return settle(1200).then(() => drawnThenRendered(open()[0], BEFORE, AFTER)).then(() => ({ late: running.length, rest: rest() }));
  });
`);

const renderAsSlideEnds = (afterMs) => scenario(`
  return start().then(() => {
    st().closeTab(open()[2]);
    return settle(${afterMs});
  }).then(() => {
    const shown = open()[5];
    st().activate(shown);
    return settle(700).then(() => drawnThenRendered(shown, BEFORE, AFTER)).then(() => ({ rest: rest() }));
  });
`);

const MOVED_PIXELS = 150;
const inPlace = (result, label) => {
  assert.deepEqual(result.rest, [], `${label}: ${result.rest.length} rows rest off their place`);
  assert.ok(result.moved < MOVED_PIXELS, `${label}: ${result.moved} sidebar pixels changed when every row rendered again, so a row was drawn off its place`);
};

try {
  app = await launch(appPath, { data, port, session: fixture, onboarded: true });
  rep.log(`instance: pid ${app.pid}, DevTools port ${app.port}, data ${data}`);
  await run(`return settle(1500);`);
  await rep.check(`a tab closes: the rows below slide up and rest in place (${trials} tries)`, async () => {
    for (let n = 0; n < trials; n++) {
      const result = await closeAndRest();
      rep.log(`try ${n}: ${JSON.stringify(result)}`);
      assert.ok(result.slid > 0, `try ${n}: no row slid`);
      inPlace(result, `try ${n}`);
    }
  });
  await rep.check(`a tab closes and the list updates while the slides run late: they land in place, no gap stays (${trials} tries)`, async () => {
    for (let n = 0; n < trials; n++) {
      const result = await closeWithLateSlides();
      rep.log(`try ${n}: ${JSON.stringify(result)}`);
      assert.ok(result.late > 0, `try ${n}: no slide was still running when the list updated`);
      inPlace(result, `try ${n}`);
    }
  });
  const delays = [120, 130, 140, 150];
  await rep.check(`a row renders as its slide ends: it stays in place (${delays.join(", ")} ms after the close, ${trials} tries each)`, async () => {
    for (const afterMs of delays)
      for (let n = 0; n < trials; n++) {
        const result = await renderAsSlideEnds(afterMs);
        rep.log(`${afterMs} ms, try ${n}: ${JSON.stringify(result)}`);
        inPlace(result, `${afterMs} ms, try ${n}`);
      }
  });
} finally {
  await app?.quit();
  server.close();
  if (!keep) rmSync(data, { recursive: true, force: true });
  else rep.say(`data and snapshots: ${scratch}`);
}
process.exit(rep.summary() ? 0 : 1);
