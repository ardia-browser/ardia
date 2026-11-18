#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const HELP = `Top tab strip UX harness: many-tab scenarios in hidden instances, scored from what the strip draws and what a
press there hits, so a layout change is judged by numbers.

  node apps/browser/scripts/topstrip-ux.mjs capture <Debug app> <out dir> [--only <regex>] [--keep]
  node apps/browser/scripts/topstrip-ux.mjs interact <Debug app> <out dir> [--only <regex>]
  node apps/browser/scripts/topstrip-ux.mjs timing <Debug app> <out dir> [--reps 5]
  node apps/browser/scripts/topstrip-ux.mjs compare <before dir> <after dir> <compare dir> [scenario …]

capture seeds five instances on throwaway data dirs (<out dir>/.data/<family>): tabs from a local server with fixed
titles (short, medium and very long, every tenth (index ending in 6) without a favicon) and a unique solid-colour favicon each, so every
tab can be found in the pixels. Each scenario resizes its window, selects a tab, sets the theme and adornments, waits
for the strip to settle, then writes <scenario>.png (the window's top 48 pt, in-process, so a locked screen is fine)
and <scenario>.json: the hit-test class of every point along y = 21 and the metrics. scores.json and scores.md
gather them. The scenario name is family-tabs-width-selection[-variant], e.g. c30-1280-mid, p10-60-900-mid,
g4-60-1280-collapsed, c30-1280-mid-light.

Metrics (definitions fixed before any change; points are window points):
  selInView     1 when the selected tab's favicon and its whole selected shape are inside the strip's viewport
  selTitlePt    width of legible title ink in the selected tab (text at least 40 levels off its background)
  identifiable  unpinned tabs whose favicon is fully drawn at full colour (at least 13 × 13 of it), over unpinned tabs
                with a favicon
  minTabPt      narrowest tab press area that is wholly visible
  medTitlePt    median legible title width across the visible unselected tabs
  newTab        1 when + and its chevron are both drawn and pressable inside the window
  dragMaxPt     longest run along y = 21 right of the window buttons where a press moves the window (the drag region,
                the scroll view's empty background and its clip view: each checked with a real press)
  deadPt        points along y = 21 where a press hits neither a control nor the window-drag region
  hiddenL/R     tabs that exist past the left / right edge of the viewport
  cueL/cueR     1 when that side hides tabs and a tab peeks there, showing ink or a favicon, faded at the edge (ink in
                the outer 8 pt at most half the strip's strongest)
  hardClips     favicons cut by an edge but still at full colour (a hard clip)
  overlaps      tab press areas overlapping + or the chevron, plus favicons overlapping each other
Added in round 2 (fixed before the round 2 changes):
  identifiable  now counts only tabs whose favicon colour is unique in the strip (a shared colour can't be attributed)
  distinct      tabs you can tell apart without hovering, over all unpinned tabs: a wholly visible tab press area whose
                favicon colour is unique among the visible ones, or whose legible title is at least 18 pt (about three
                characters); a faded or favicon-less tab counts only by its title
  titledTabs    visible unselected tabs with at least 18 pt of legible title
  selPt         width of the selected tab's press area (a split pane's own)
  fadeCueL/R    from the opacities the strip drives (its dev registry: each chip's centre, the scroll and the same
                formula the native fade runs): 1 when that side hides chips and the outermost visible chip there is at
                most 0.6 opaque
  fadeErrors    chips at least the fade width plus 4 pt inside both edges drawn below 0.98 opacity

interact runs the interactions (reveal on select, closing under a still pointer, new and background tabs, wheel and
trackpad scrolls, an edge drag, resizes) and writes interact.json; frame bursts go to <out dir>/frames/<name>/.
timing runs open, close and switch at 120 tabs and a scroll, interleaved with the same actions in the sidebar layout
as the control, and writes timing.json. compare writes before-over-after PNGs and a score table into <compare dir>.`;

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 64);
}
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["--keep"].includes(argv[i - 1])));
const [mode, ...rest] = positional;

const CROP_HEIGHT = 48;
const STRIP_Y = 21;
const WINDOW_HEIGHT = 640;

function palette(n) {
  const levels = [0, 51, 102, 153, 204, 255];
  const out = [];
  for (const r of levels) for (const g of levels) for (const b of levels) if (Math.max(r, g, b) - Math.min(r, g, b) >= 102) out.push([r, g, b]);
  const order = out.map((c, i) => [((i * 97) % out.length), c]).sort((x, y) => x[0] - y[0]).map(([, c]) => c);
  if (order.length < n) throw new Error(`palette has ${order.length} colours`);
  return order.slice(0, n);
}
const COLOURS = palette(140);

const TITLES = [
  (i) => `Tab ${i} · How to keep a long title readable when the tab strip is full of other tabs`,
  (i) => `Tab ${i}`,
  (i) => `Tab ${i} · Pull request #${1000 + i}: strip overflow`,
  (i) => `Tab ${i} — Inbox (${i})`,
  (i) => `Tab ${i} · Quarterly planning notes and the roadmap for next year`,
];
const titleOf = (i) => TITLES[i % TITLES.length](i);
const hasFavicon = (i) => i % 10 !== 6;
const SITE_WORDS = ["Issues", "Pulls", "Actions", "Wiki", "Insights", "Settings", "Releases", "Budget", "Roadmap", "Hiring", "Payroll", "Offsite", "Design", "Metrics", "Pricing", "Support", "Legal", "Launch", "Retro", "Standup", "Calendar", "Inbox", "Drafts", "Travel", "Recipes", "Garden", "Taxes", "Lease", "Quotes", "Invoice", "Mockups", "Tokens", "Specs", "Bugs", "Triage", "Backlog", "Sprint", "Review", "Deploy", "Alerts", "Logs", "Traces", "Storage", "Network", "Onboarding", "Payments", "Search", "Sync", "Themes", "Profiles", "Exports", "Imports", "Webhooks", "Keys", "Quota", "Usage", "Contracts", "Vendors", "Assets", "Fonts"];
const SHARED_FAVICON = 138;
const siteShared = (n, i) => (n <= 30 ? (i >= 5 && i <= 14) || [18, 21, 24, 27, 29].includes(i) : (i >= 10 && i <= 29) || [33, 37, 41, 45, 49, 53, 57].includes(i));
const siteTitle = (i) => `${SITE_WORDS[i % SITE_WORDS.length]}${i >= SITE_WORDS.length ? ` ${i}` : ""} · project tracker page ${i}`;
const siteFavicon = (n, i) => (siteShared(n, i) ? SHARED_FAVICON : hasFavicon(i) ? i : null);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function encodePng({ width, height, rgba }) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function solidPng([r, g, b]) {
  const rgba = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 256; i++) rgba.set([r, g, b, 255], i * 4);
  return encodePng({ width: 16, height: 16, rgba });
}
function readPng(path) {
  const buf = readFileSync(path);
  let width = 0, height = 0, channels = 4;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(at + 8);
      height = buf.readUInt32BE(at + 12);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[buf[at + 17]];
    } else if (type === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride, src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y ? out[row - stride + x] : 0;
      const c = y && x >= channels ? out[row - stride + x - channels] : 0;
      let p;
      if (filter === 0) p = v;
      else if (filter === 1) p = v + a;
      else if (filter === 2) p = v + b;
      else if (filter === 3) p = v + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[row + x] = p & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const grey = channels <= 2;
    rgba[i * 4] = out[s];
    rgba[i * 4 + 1] = grey ? out[s] : out[s + 1];
    rgba[i * 4 + 2] = grey ? out[s] : out[s + 2];
    rgba[i * 4 + 3] = channels === 4 ? out[s + 3] : channels === 2 ? out[s + 1] : 255;
  }
  return { width, height, rgba };
}
function cropPng(img, height) {
  const h = Math.min(height, img.height);
  return { width: img.width, height: h, rgba: Buffer.from(img.rgba.subarray(0, img.width * 4 * h)) };
}

function startServer() {
  const server = createServer((req, res) => {
    const fav = /^\/fav\/(\d+)\.png/.exec(req.url);
    if (fav) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
      return res.end(solidPng(COLOURS[Number(fav[1])] ?? [128, 128, 128]));
    }
    const page = /^\/page\/([^/]+)\/(\d+)/.exec(req.url);
    if (/^\/slow\//.test(req.url)) return;
    if (page) {
      const i = Number(page[2]);
      const site = /^ss(\d+)/.exec(page[1]);
      const k = page[1].startsWith("pin") ? 130 + (i % 10) : site ? siteFavicon(Number(site[1]), i) : hasFavicon(i) ? i : null;
      const icon = k !== null ? `<link rel="icon" href="/fav/${k}.png">` : "";
      const title = page[1].startsWith("pin") ? `Pinned ${i}` : site ? siteTitle(i) : titleOf(i);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><title>${title}</title>${icon}<body style="font:14px sans-serif;background:#fff;margin:0"><div style="height:6000px;background:linear-gradient(#fff,#ddd)">${title}</div></body>`);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function tabsFor(windowId, n, port, { pinned = 0, profileId = "default", site = false } = {}) {
  const pins = Array.from({ length: pinned }, (_, i) => ({
    id: `${windowId}-p${i}`, windowId, profileId, pinned: true, pin: { as: "tile" },
    url: `http://127.0.0.1:${port}/page/pin/${i}`, title: `Pinned ${i}`, favicon: `http://127.0.0.1:${port}/fav/${130 + i}.png`, lastActiveAt: 1,
  }));
  const tabs = Array.from({ length: n }, (_, i) => {
    const fav = site ? siteFavicon(n, i) : hasFavicon(i) ? i : null;
    return {
      id: `${windowId}-t${i}`, windowId, profileId,
      url: `http://127.0.0.1:${port}/page/${windowId}/${i}`, title: site ? siteTitle(i) : titleOf(i),
      favicon: fav !== null ? `http://127.0.0.1:${port}/fav/${fav}.png` : null, lastActiveAt: 2 + i,
    };
  });
  return [...pins, ...tabs];
}

const FAMILIES = {
  counts: { counts: [5, 10, 15, 20, 25, 30, 60, 120], pinned: 0 },
  site: { counts: [30, 60], pinned: 0 },
  structure: { pinned: 0 },
  p4: { counts: [30, 60], pinned: 4 },
  p10a: { counts: [30], pinned: 10 },
  p10b: { counts: [60], pinned: 10 },
  timing: { counts: [120], pinned: 0 },
};

function familySession(family, port) {
  const spec = FAMILIES[family];
  const windows = [];
  const tabs = [];
  const groups = [];
  let y = 40;
  const add = (id, n, extra = {}) => {
    const ts = tabsFor(id, n, port, { pinned: spec.pinned, site: family === "site" });
    tabs.push(...ts);
    windows.push({ id, frame: [40, y, 1280, WINDOW_HEIGHT], sidebarOpen: true, tabLayout: "top", tabIds: ts.map((t) => t.id), activeTabIds: { default: `${id}-t${Math.floor(n / 2)}` }, createdAt: windows.length + 1, ...extra });
    y += 3;
    return ts;
  };
  if (family === "structure") {
    add("g1", 30);
    groups.push({ id: "g1-A", windowId: "g1", profileId: "default", name: "Research", icon: null, color: null, collapsed: false, pinned: false, tabIds: [12, 13, 14, 15, 16, 17].map((i) => `g1-t${i}`), createdAt: 1 });
    add("g4", 60);
    const g = (name, from, to, collapsed) => ({ id: `g4-${name}`, windowId: "g4", profileId: "default", name, icon: null, color: null, collapsed, pinned: false, tabIds: Array.from({ length: to - from }, (_, k) => `g4-t${from + k}`), createdAt: from });
    groups.push(g("Work", 4, 10, false), g("Shopping", 18, 26, true), g("Reading", 30, 38, false), g("Trip", 44, 52, true));
    add("s", 30);
    add("sg", 40);
    groups.push({ id: "sg-P", windowId: "sg", profileId: "default", name: "Pair", icon: null, color: null, collapsed: false, pinned: false, tabIds: [24, 25, 26, 27, 28, 29].map((i) => `sg-t${i}`), createdAt: 1 });
    add("sh", 40);
    groups.push({ id: "sh-P", windowId: "sh", profileId: "default", name: "Pair", icon: null, color: null, collapsed: false, pinned: false, tabIds: [4, 5, 6, 7, 8, 9].map((i) => `sh-t${i}`), createdAt: 1 });
  } else if (family === "site") {
    add("ss30", 30);
    add("ss60", 60);
  } else if (family === "timing") {
    add("c120", 120);
    add("k120", 120, { tabLayout: "sidebar" });
  } else for (const n of spec.counts) add(`c${n}`, n);
  const s = session({ windows, tabs, groups, settings: { tabLayout: "top", appearance: "dark", revealTabsOnHover: true } });
  for (const w of s.windows) w.tabLayout = windows.find((x) => x.id === w.id)?.tabLayout ?? "top";
  return s;
}

const SCENARIOS = (() => {
  const list = [];
  const sc = (name, family, window, o) => list.push({ name, family, window, ...o });
  for (const n of [5, 15, 30, 60, 120]) for (const width of [900, 1280, 1728]) sc(`c${n}-${width}-mid`, "counts", `c${n}`, { n, width, sel: "mid" });
  for (const n of [10, 20, 25]) for (const width of [900, 1280]) sc(`c${n}-${width}-mid`, "counts", `c${n}`, { n, width, sel: "mid" });
  for (const width of [900, 1280, 1728]) sc(`ss30-${width}-mid`, "site", "ss30", { n: 30, width, sel: "mid" });
  for (const width of [1280, 1728]) sc(`ss60-${width}-mid`, "site", "ss60", { n: 60, width, sel: "mid" });
  sc("ss30-1280-inrun", "site", "ss30", { n: 30, width: 1280, sel: 9 });
  sc("ss60-1280-inrun", "site", "ss60", { n: 60, width: 1280, sel: 20 });
  for (const n of [30, 120]) for (const sel of ["start", "end"]) sc(`c${n}-1280-${sel}`, "counts", `c${n}`, { n, width: 1280, sel });
  for (const n of [30, 120]) sc(`c${n}-1280-mid-light`, "counts", `c${n}`, { n, width: 1280, sel: "mid", theme: "light" });
  sc("c30-1280-mid-adorned", "counts", "c30", { n: 30, width: 1280, sel: "mid", adorn: true });
  sc("c60-1280-mid-adorned", "counts", "c60", { n: 60, width: 1280, sel: "mid", adorn: true });
  for (const [fam, pins] of [["p4", 4], ["p10a", 10], ["p10b", 10]]) {
    const counts = FAMILIES[fam].counts;
    for (const n of counts) for (const width of [900, 1280]) sc(`p${pins}-${n}-${width}-mid`, fam, `c${n}`, { n, width, sel: "mid", pinned: pins });
  }
  sc("p10-30-1280-pinsel", "p10a", "c30", { n: 30, width: 1280, sel: "pin", pinned: 10 });
  for (const width of [900, 1280]) sc(`g1-30-${width}-ingroup`, "structure", "g1", { n: 30, width, sel: 14 });
  sc("g1-30-1280-outside", "structure", "g1", { n: 30, width: 1280, sel: 25 });
  sc("g4-60-1280-collapsed", "structure", "g4", { n: 60, width: 1280, sel: 20 });
  sc("g4-60-1728-collapsed", "structure", "g4", { n: 60, width: 1728, sel: 20 });
  sc("g4-60-1280-open", "structure", "g4", { n: 60, width: 1280, sel: 33 });
  sc("s-30-1280-splitsel", "structure", "s", { n: 30, width: 1280, sel: 15, split: [15, 16] });
  sc("s-30-1280-splitaway", "structure", "s", { n: 30, width: 1280, sel: 3, split: [15, 16] });
  sc("sg-40-1280-open-splitsel", "structure", "sg", { n: 40, width: 1280, sel: 26, split: [26, 27], collapse: false });
  sc("sg-40-1280-open-splitaway", "structure", "sg", { n: 40, width: 1280, sel: 35, split: [26, 27], collapse: false });
  sc("sg-40-1280-collapsed-splitsel", "structure", "sg", { n: 40, width: 1280, sel: 26, split: [26, 27], collapse: true });
  sc("sg-40-1280-collapsed-splitaway", "structure", "sg", { n: 40, width: 1280, sel: 35, split: [26, 27], collapse: true });
  sc("sh-40-1280-open-splitsel", "structure", "sh", { n: 40, width: 1280, sel: 6, split: [6, 7], collapse: false });
  sc("sh-40-1280-open-splitaway", "structure", "sh", { n: 40, width: 1280, sel: 2, split: [6, 7], collapse: false });
  return list;
})();

const HELPERS = `
const st = () => ac.store.getState();
const D = globalThis.expo.modules.ArdiaDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const nativeOf = (frame) => ac.engine.call("windows.list").then((ws) => {
  const found = ws.filter((w) => w.hasRoot).find((w) => { const r = w.frame.match(/[-\\d.]+/g).map(Number); return r.every((v, i) => Math.abs(v - frame[i]) < 1); });
  return found ? found.window : null;
});
const classify = (h) => /_NSTheme/.test(h) ? "L" : /^ArdiaShell\\.WindowDragRegion/.test(h) ? "D" : /^(RCTScrollContentView|NSClipView)/.test(h) ? "S" : /^NativeWidgetMac/.test(h) ? "E"
  : /FileDragView/.test(h) ? "T" : /^(RCTView < )+ArdiaShell\\.ContextMenuArea < ArdiaShell\\.FileDropView/.test(h) ? "X" : "I";
const hitRow = (n, width, y) => {
  const xs = []; for (let x = 0; x < width; x++) xs.push(x);
  const out = [];
  const chunk = (i) => i >= xs.length ? Promise.resolve(out) : Promise.all(xs.slice(i, i + 240).map((x) => ac.engine.call("windows.dev", { window: n, action: "hit:" + (x + 0.5) + "," + y }))).then((hs) => { out.push(...hs); return chunk(i + 240); });
  return chunk(0);
};
const stripOrder = (id) => st().windows[id].tabIds.filter((t) => st().tabs[t] && st().tabs[t].profileId === st().windows[id].profileId);
`;

const setupBody = (sc, png) => `${HELPERS}
const id = ${JSON.stringify(sc.window)};
const sc = ${JSON.stringify(sc)};
const s0 = st();
const w0 = s0.windows[id];
const tabIds = stripOrder(id);
const loose = tabIds.filter((t) => !s0.tabs[t].pin);
const pins = tabIds.filter((t) => s0.tabs[t].pin);
const pick = sc.sel === "start" ? loose[0] : sc.sel === "end" ? loose[loose.length - 1] : sc.sel === "mid" ? loose[Math.floor(loose.length / 2)] : sc.sel === "pin" ? pins[Math.floor(pins.length / 2)] : loose[sc.sel];
if (s0.settings.appearance !== (sc.theme || "dark")) s0.updateSettings({ appearance: sc.theme || "dark" });
let nativeFrame = null;
const live = { ...st().live };
for (const t of loose) live[t] = { ...(live[t] || {}), playingAudio: false, isLoading: false };
const discarded = {};
if (sc.adorn) {
  const at = loose.indexOf(pick);
  live[loose[at - 1]] = { ...live[loose[at - 1]], playingAudio: true };
  live[pick] = { ...live[pick], playingAudio: true };
  live[loose[at + 2]] = { ...live[loose[at + 2]], isLoading: true };
  discarded[loose[at + 3]] = true;
}
ac.store.setState({ live });
return Promise.resolve()
  .then(() => sc.adorn && !st().tabs[loose[loose.indexOf(pick) + 1]].muted ? ac.actions.toggleMute(loose[loose.indexOf(pick) + 1]) : null)
  .then(() => sc.split && !Object.values(st().splits).some((x) => x.windowId === id) ? st().openSplitPane(id, { tabId: loose[sc.split[1]], anchorTabId: loose[sc.split[0]], side: "right" }) : null)
  .then(() => { if (sc.collapse === undefined) return; const g = Object.values(st().groups).find((x) => x.windowId === id); if (g && g.collapsed !== sc.collapse) st().updateGroup(g.id, { collapsed: sc.collapse }); })
  .then(() => ac.actions.switchToTab(pick))
  .then(() => D.devSetWindowFrame(id, [40 + Object.keys(s0.windows).indexOf(id) * 11, 60 + Object.keys(s0.windows).indexOf(id) * 7, sc.width, ${WINDOW_HEIGHT}]))
  .then((frame) => { nativeFrame = frame; })
  .then(() => D.devSetPointer(id, sc.width / 2, 400, true))
  .then(() => wait(1400)).then(() => frames(4))
  .then(() => D.devSnapshotWindow(id, ${JSON.stringify(png)}, false))
  .then((ok) => nativeOf(nativeFrame).then((n) => { if (!n) throw new Error("no native window for " + JSON.stringify(nativeFrame)); return n; }).then((n) => hitRow(n, sc.width, ${STRIP_Y}).then((hits) => ({ ok, n, hits }))))
  .then(({ ok, n, hits }) => {
    const s = st();
    const order = stripOrder(id);
    const codes = hits.map((h) => classify(h));
    const chains = {}; hits.forEach((h, x) => { const c = codes[x]; if (c === "I" || c === "X") chains[h] = (chains[h] || 0) + 1; });
    const page = (globalThis.topStripPages || {})[id + "|" + s.windows[id].profileId];
    const strip = page ? { scroll: page.scroll(), chips: page.chips(), fadeWidth: page.fadeWidth } : null;
    return { ok, n, strip, codes: codes.join(""), chains, order, loose: order.filter((t) => !s.tabs[t].pin), pins: order.filter((t) => s.tabs[t].pin),
      active: s.windows[id].activeTabIds[s.windows[id].profileId], picked: pick, frame: s.windows[id].frame,
      favicons: Object.fromEntries(order.map((t) => [t, s.tabs[t].favicon])), dark: s.settings.appearance !== "light",
      discarded: Object.keys(discarded), muted: order.filter((t) => s.tabs[t].muted) };
  });
`;

const colourOfTab = (tabId, favicon) => {
  if (!favicon) return null;
  const m = /\/fav\/(\d+)\.png/.exec(favicon);
  return m ? COLOURS[Number(m[1])] : null;
};

function analyse(img, scale, data, width) {
  const px = (x, y) => {
    const X = Math.round(x * scale), Y = Math.round(y * scale);
    if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) return [0, 0, 0];
    const o = (Y * img.width + X) * 4;
    return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]];
  };
  const diff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  const codes = data.codes;
  const lightsEnd = codes.lastIndexOf("L") + 1;
  const runs = (pred) => {
    const out = [];
    let start = -1;
    for (let x = 0; x <= codes.length; x++) {
      const on = x < codes.length && pred(codes[x], x);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        out.push([start, x]);
        start = -1;
      }
    }
    return out;
  };
  const tabRuns = runs((c) => c === "T");
  const dragRuns = runs((c, x) => (c === "D" || c === "S") && x >= lightsEnd);
  const dragMaxPt = Math.max(0, ...dragRuns.map(([a, b]) => b - a));
  const deadPt = codes.split("").filter((c, x) => c === "X" && x >= lightsEnd).length;
  const buttonRuns = runs((c) => c === "I").filter(([a, b]) => b - a >= 14 && a > lightsEnd);

  const W = Math.round(width);
  const bgRow = [];
  for (let x = 0; x < W; x++) bgRow.push(px(x, 1));
  const bg = bgRow.slice().sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]))[Math.floor(bgRow.length / 2)];

  const favs = [];
  const tol = 12;
  const colourUse = {};
  for (const tabId of data.order) {
    const k = data.favicons[tabId] && /\/fav\/(\d+)\.png/.exec(data.favicons[tabId])?.[1];
    if (k) colourUse[k] = (colourUse[k] || 0) + 1;
  }
  const sharedColour = (tabId) => {
    const k = data.favicons[tabId] && /\/fav\/(\d+)\.png/.exec(data.favicons[tabId])?.[1];
    return !!k && colourUse[k] > 1;
  };
  for (const tabId of data.order) {
    const c = colourOfTab(tabId, data.favicons[tabId]);
    if (!c || sharedColour(tabId)) continue;
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, count = 0;
    for (let y = 8; y < 36; y++)
      for (let x = 0; x < W; x++) {
        if (diff(px(x, y), c) <= tol) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    if (!count) continue;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    favs.push({ tabId, x: minX, w, h, count, full: w >= 13 && h >= 13 && count >= 150 });
  }
  const favOf = new Map(favs.map((f) => [f.tabId, f]));
  const loose = data.loose;
  const withFav = loose.filter((t) => data.favicons[t] && !data.discarded.includes(t) && !sharedColour(t));
  const shown = withFav.filter((t) => favOf.get(t)?.full);
  const shownIdx = shown.map((t) => loose.indexOf(t));
  const firstShown = shownIdx.length ? Math.min(...shownIdx) : -1;
  const lastShown = shownIdx.length ? Math.max(...shownIdx) : -1;
  const hiddenL = firstShown < 0 ? 0 : loose.slice(0, firstShown).filter((t) => !favOf.get(t)?.full).length;
  const hiddenR = lastShown < 0 ? 0 : loose.slice(lastShown + 1).filter((t) => !favOf.get(t)?.full).length;
  const hardClips = favs.filter((f) => !f.full && f.count >= 16).length;

  const runOf = (x) => tabRuns.find(([a, b]) => x >= a && x < b);
  const scrollRuns = runs((c) => c === "T" || c === "S");
  const viewport = scrollRuns.length ? [Math.min(...scrollRuns.map((r) => r[0])), Math.max(...scrollRuns.map((r) => r[1]))] : [0, 0];
  const inkWidth = (a, b, startX) => {
    let first = -1, last = -1, maxInk = 0;
    for (let x = Math.max(a, startX); x < b; x++) {
      const base = px(x, 35);
      let ink = 0;
      for (let y = 15; y <= 27; y++) ink = Math.max(ink, diff(px(x, y), base));
      maxInk = Math.max(maxInk, ink);
      if (ink >= 40) {
        if (first < 0) first = x;
        last = x;
      }
    }
    return { pt: first < 0 ? 0 : last - first + 1, maxInk };
  };
  const tabSpans = [];
  for (const t of loose) {
    const f = favOf.get(t);
    if (!f || !f.full) continue;
    const r = runOf(f.x + 8);
    if (!r) continue;
    const title = inkWidth(r[0], r[1], f.x + f.w + 2);
    tabSpans.push({ tabId: t, run: r, fav: f, titlePt: title.pt, clipped: r[0] <= viewport[0] + 1 || r[1] >= viewport[1] - 1 });
  }
  const sel = data.active;
  const selFav = favOf.get(sel);
  let selSpan = [-1, -1];
  for (let x = 0; x < W; x++) {
    if (diff(px(x, 4), bg) > 6) {
      if (selSpan[0] < 0) selSpan[0] = x;
      selSpan[1] = x + 1;
    }
  }
  const isPinnedSel = data.pins.includes(sel);
  const selRun = selFav ? runOf(selFav.x + 8) : null;
  const selInView = isPinnedSel ? (selFav?.full ? 1 : 0) : selFav?.full && selRun && selSpan[0] >= selRun[0] + 2 && selSpan[1] <= selRun[1] - 2 ? 1 : 0;
  const selTitlePt = selFav?.full && selRun && !isPinnedSel ? inkWidth(selRun[0], selRun[1], selFav.x + selFav.w + 2).pt : 0;
  const visible = tabSpans.filter((s) => !s.clipped);
  const minTabPt = visible.length ? Math.min(...visible.map((s) => s.run[1] - s.run[0])) : 0;
  const others = visible.filter((s) => s.tabId !== sel).map((s) => s.titlePt).sort((a, b) => a - b);
  const medTitlePt = others.length ? others[Math.floor(others.length / 2)] : 0;
  const grouped = buttonRuns.reduce((acc, r) => (acc.length && r[0] - acc.at(-1)[1] <= 8 ? (acc.at(-1)[1] = r[1], acc) : [...acc, [...r]]), []);
  const newTab = grouped.some(([a, b]) => b - a >= 50 && b <= W - 2) ? 1 : 0;
  const overlaps =
    tabRuns.filter(([a, b]) => buttonRuns.some(([c, d]) => a < d && c < b)).length +
    favs.filter((f, i) => f.full && favs.some((g, j) => j !== i && g.full && f.x < g.x + g.w && g.x < f.x + f.w)).length;
  const stripInk = Math.max(1, ...tabSpans.map((s) => inkWidth(s.run[0], s.run[1], s.fav.x).maxInk));
  const cue = (side) => {
    const hidden = side === "L" ? hiddenL : hiddenR;
    if (!hidden) return null;
    const edge = side === "L" ? viewport[0] : viewport[1];
    const peek = tabRuns.find(([a, b]) => (side === "L" ? a <= edge + 1 : b >= edge - 1));
    if (!peek) return 0;
    const a = side === "L" ? edge : edge - 8;
    const shows = inkWidth(peek[0], peek[1], peek[0]).maxInk >= 40 || favs.some((f) => f.count >= 16 && f.x < peek[1] && f.x + f.w > peek[0]);
    return shows && inkWidth(a, a + 8, a).maxInk <= stripInk / 2 ? 1 : 0;
  };
  const PINNED_COLOURS = new Set([130, 131, 132, 133, 134, 135, 136, 137, 139]);
  const colourIn = (a, b) => {
    const tally = new Map();
    for (let y = 13; y <= 28; y++)
      for (let x = a; x < b; x++) {
        const p = px(x, y);
        for (let k = 0; k < COLOURS.length; k++) if (diff(p, COLOURS[k]) <= tol) tally.set(k, (tally.get(k) || 0) + 1);
      }
    let best = null;
    for (const [k, n] of tally) if (n >= 150 && (!best || n > best[1])) best = [k, n];
    if (!best) return null;
    let left = b;
    for (let y = 13; y <= 28; y++) for (let x = a; x < b; x++) if (diff(px(x, y), COLOURS[best[0]]) <= tol) left = Math.min(left, x);
    return { k: best[0], right: left + 16 };
  };
  const shown2 = tabRuns.filter(([a, b]) => a > viewport[0] + 1 && b < viewport[1] - 1).map(([a, b]) => {
    const c = colourIn(a, b);
    return { a, b, k: c?.k ?? null, title: inkWidth(a, b, c ? c.right + 2 : a + 28).pt, selected: selSpan[0] >= 0 && a < selSpan[1] && selSpan[0] < b };
  }).filter((r) => r.k === null || !PINNED_COLOURS.has(r.k));
  const kCount = {};
  for (const r of shown2) if (r.k !== null) kCount[r.k] = (kCount[r.k] || 0) + 1;
  const TITLE_USEFUL = 18;
  const distinguishable = shown2.filter((r) => (r.k !== null && kCount[r.k] === 1) || r.title >= TITLE_USEFUL);
  const distinct = loose.length ? +(distinguishable.length / loose.length).toFixed(3) : 1;
  const titledTabs = shown2.filter((r) => !r.selected && r.title >= TITLE_USEFUL).length;
  const selPt = selRun ? selRun[1] - selRun[0] : 0;
  let fadeCueL = null, fadeCueR = null, fadeErrors = null, fadeUnplaced = null;
  if (data.strip) {
    const { scroll, chips, fadeWidth } = data.strip;
    const L = scroll.x, R = scroll.x + scroll.viewport;
    const placed = chips.filter((c) => c.centre > -1e5);
    const vis = placed.filter((c) => c.centre >= L && c.centre <= R).sort((p, q) => p.centre - q.centre);
    fadeCueL = placed.some((c) => c.centre < L) ? (vis.length && vis[0].opacity <= 0.6 ? 1 : 0) : null;
    fadeCueR = placed.some((c) => c.centre > R) ? (vis.length && vis.at(-1).opacity <= 0.6 ? 1 : 0) : null;
    fadeErrors = placed.filter((c) => c.centre >= L + fadeWidth + 4 && c.centre <= R - fadeWidth - 4 && c.opacity < 0.98).length;
    fadeUnplaced = chips.length - placed.length;
  }
  return {
    distinct, titledTabs, selPt, fadeCueL, fadeCueR, fadeErrors, fadeUnplaced,
    selInView, selTitlePt, identifiable: withFav.length ? +(shown.length / withFav.length).toFixed(3) : 1, shown: shown.length, withFav: withFav.length,
    minTabPt, medTitlePt, newTab, dragMaxPt, deadPt, hiddenL, hiddenR, cueL: cue("L"), cueR: cue("R"), hardClips, overlaps,
    detail: { viewport, selSpan, lightsEnd, buttons: buttonRuns, drags: dragRuns.filter(([a, b]) => b - a >= 6), tabs: tabSpans.map((s) => [s.tabId.split("-").pop(), ...s.run, s.titlePt]), favs: favs.map((f) => [f.tabId.split("-").pop(), f.x, f.full ? 1 : 0]) },
  };
}

async function launchFamily(app, family, out, port) {
  const data = join(out, ".data", family);
  const inst = await launch(app, { data, fresh: true, session: familySession(family, port), onboarded: true, startTimeout: 120000 });
  await inst.eval(`return new Promise((r) => setTimeout(r, 4000)).then(() => ac.store.getState().windowOrder);`, { timeout: 60000 });
  return inst;
}

async function capture(app, out) {
  mkdirSync(out, { recursive: true });
  const only = flag("only") ? new RegExp(flag("only")) : null;
  const todo = SCENARIOS.filter((s) => !only || only.test(s.name));
  const families = [...new Set(todo.map((s) => s.family))];
  const server = await startServer();
  const port = server.address().port;
  const results = {};
  const instances = [];
  try {
    const launched = await Promise.all(families.map(async (f) => [f, await launchFamily(app, f, out, port)]));
    for (const [, inst] of launched) instances.push(inst);
    await Promise.all(
      launched.map(async ([family, inst]) => {
        for (const sc of todo.filter((s) => s.family === family)) {
          const png = join(out, `${sc.name}.full.png`);
          let data;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              data = await inst.eval(setupBody(sc, png), { timeout: 120000 });
              break;
            } catch (e) {
              if (attempt) throw e;
            }
          }
          const img = readPng(png);
          const scale = img.width / sc.width;
          const metrics = analyse(img, scale, data, sc.width);
          writeFileSync(join(out, `${sc.name}.png`), encodePng(cropPng(img, Math.round(CROP_HEIGHT * scale))));
          rmSync(png, { force: true });
          writeFileSync(join(out, `${sc.name}.json`), JSON.stringify({ scenario: sc, metrics, data: { ...data, favicons: undefined } }, null, 1));
          results[sc.name] = metrics;
          console.log(`${sc.name.padEnd(26)} ${summaryLine(metrics)}`);
        }
      }),
    );
  } finally {
    const prior = existsSync(join(out, "scores.json")) ? JSON.parse(readFileSync(join(out, "scores.json"), "utf8")) : {};
    const merged = { ...prior, ...results };
    writeFileSync(join(out, "scores.json"), JSON.stringify(merged, (k, v) => (k === "detail" ? undefined : v), 1));
    writeFileSync(join(out, "scores.md"), scoreTable(merged));
    if (!argv.includes("--keep")) for (const inst of instances) await inst.quit().catch(() => {});
    server.close();
  }
}

const METRICS = ["selInView", "selTitlePt", "selPt", "identifiable", "distinct", "titledTabs", "minTabPt", "medTitlePt", "newTab", "dragMaxPt", "deadPt", "hiddenL", "hiddenR", "cueL", "cueR", "fadeCueL", "fadeCueR", "fadeErrors", "hardClips", "overlaps"];
const summaryLine = (m) => METRICS.map((k) => `${k}=${m[k] ?? "-"}`).join(" ");
const scoreTable = (scores) =>
  [`| scenario | ${METRICS.join(" | ")} |`, `|${" --- |".repeat(METRICS.length + 1)}`, ...Object.entries(scores).map(([name, m]) => `| ${name} | ${METRICS.map((k) => m[k] ?? "–").join(" | ")} |`)].join("\n") + "\n";

const BETTER = { selPt: 1, distinct: 1, titledTabs: 1, fadeCueL: 1, fadeCueR: 1, fadeErrors: -1, selInView: 1, selTitlePt: 1, identifiable: 1, minTabPt: 1, medTitlePt: 1, newTab: 1, dragMaxPt: 1, deadPt: -1, hiddenL: 0, hiddenR: 0, cueL: 1, cueR: 1, hardClips: -1, overlaps: -1 };

function compare(beforeDir, afterDir, outDir, names) {
  mkdirSync(outDir, { recursive: true });
  const before = JSON.parse(readFileSync(join(beforeDir, "scores.json"), "utf8"));
  const after = JSON.parse(readFileSync(join(afterDir, "scores.json"), "utf8"));
  const rows = [];
  const worse = [];
  for (const name of Object.keys(before)) {
    const a = before[name], b = after[name];
    if (!b) continue;
    rows.push(`| ${name} | ${METRICS.map((k) => (a[k] === b[k] ? `${a[k] ?? "–"}` : `${a[k] ?? "–"} → **${b[k] ?? "–"}**`)).join(" | ")} |`);
    for (const k of METRICS) {
      const dir = BETTER[k];
      if (!dir || a[k] == null || b[k] == null) continue;
      if ((b[k] - a[k]) * dir < 0) worse.push(`${name} ${k}: ${a[k]} → ${b[k]}`);
    }
  }
  const md = [`| scenario | ${METRICS.join(" | ")} |`, `|${" --- |".repeat(METRICS.length + 1)}`, ...rows].join("\n");
  writeFileSync(join(outDir, "scores.md"), `${md}\n\n## Worse after\n\n${worse.map((w) => `- ${w}`).join("\n") || "- none"}\n`);
  const pick = names.length ? names : Object.keys(before).filter((n) => after[n]);
  for (const name of pick) {
    const a = join(beforeDir, `${name}.png`), b = join(afterDir, `${name}.png`);
    if (!existsSync(a) || !existsSync(b)) continue;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", a, "-i", b, "-filter_complex", "[0]pad=iw:ih+6:0:0:red[t];[t][1]vstack", join(outDir, `${name}.png`)]);
  }
  console.log(md);
  console.log(worse.length ? `worse:\n${worse.join("\n")}` : "nothing worse");
}

const app = rest[0];
if (mode === "capture") await capture(resolve(app), resolve(rest[1]));
else if (mode === "compare") compare(resolve(rest[0]), resolve(rest[1]), resolve(rest[2]), rest.slice(3));
else if (mode === "interact" || mode === "timing") {
  const { runInteractions, runTiming } = await import(join(dirname(fileURLToPath(import.meta.url)), "topstrip-ux-interact.mjs"));
  const ctx = { app: resolve(app), out: resolve(rest[1]), flag, startServer, familySession, launch, HELPERS, readPng, encodePng, analyse, COLOURS, sleep };
  if (mode === "interact") await runInteractions(ctx);
  else await runTiming(ctx);
} else {
  console.log(HELP);
  process.exit(64);
}
