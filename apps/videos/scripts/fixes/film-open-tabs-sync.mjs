import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const { devtools, launch, session, sleep } = await import(join(repo, "scripts/lib/instance.mjs"));

const APP = process.env.AFTER_APP ?? join(repo, "apps/browser/build-topstrip/Build/Products/Debug/Ardia.app");
const scratch = process.env.FILM_SCRATCH ?? "/tmp/open-tabs-sync-film";
const footage = join(repo, "apps/videos/public/footage/open-tabs-sync");
const timelineFile = join(repo, "apps/videos/src/videos/open-tabs-sync/timeline.json");
const ports = { A: Number(process.env.FILM_PORT_A ?? 9783), B: Number(process.env.FILM_PORT_B ?? 9784) };
const folder = join(scratch, "folder");
const WINDOW = { w: 1280, h: 800 };
const SIDEBAR = 260;
const ROW0 = 85;
const ROW = 37;
const TOGGLE = [765, 393];
const CMD = 1048576;
const SHIFT = 131072;
const START_TABS = {
  A: [{ id: "sourdough", url: "https://en.wikipedia.org/wiki/Sourdough", title: "Sourdough - Wikipedia" }],
  B: [{ id: "mac", url: "https://en.wikipedia.org/wiki/Mac_(computer)", title: "Mac (computer) - Wikipedia" }],
};
const TYPED = ["en.wikipedia.org/wiki/espresso", "github.com/ardia-browser/ardia"];

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const marks = {};
const mark = (name) => {
  marks[name] = Date.now();
  log("mark", name);
};

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(footage, { recursive: true, force: true });
for (const name of ["A", "B"]) fs.mkdirSync(join(footage, name), { recursive: true });
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(dirname(timelineFile), { recursive: true });

function startSession(tabs) {
  const s = session({ profiles: [{ id: "default", name: "Personal", color: "plum" }], windows: [{ id: "w1", frame: [0, 33, WINDOW.w, WINDOW.h] }], tabs });
  s.settings = { warnBeforeQuitting: false, searchSuggestions: false, sidebarWidth: SIDEBAR };
  return s;
}

const apps = {};
const start = async (name) => {
  apps[name] = await launch(APP, {
    data: join(scratch, name),
    port: ports[name],
    onboarded: true,
    session: startSession(START_TABS[name]),
    instance: { syncFolder: folder },
    test: { reauth: "granted" },
    files: { "telemetry.json": { sharing: false, decidedAt: 1, askDoneAt: 1 } },
    ready: { timeout: 120000, test: "return !!globalThis.acSync && Object.keys(ac.store.getState().windows).length > 0" },
  });
  log(name, "pid", apps[name].pid, "port", apps[name].port);
};
const ev = (name, body, timeout = 90000) => apps[name].eval(body, { timeout });
const syncNow = (name) => ev(name, "return acSync.syncNow().then(() => acSync.useSync.getState().status)");
async function until(what, test, names, timeout = 90000) {
  for (const end = Date.now() + timeout; Date.now() < end; ) {
    const got = await test();
    if (got) return got;
    for (const n of names) await syncNow(n);
  }
  throw new Error(`timed out: ${what}`);
}
const tabsOf = (name) =>
  ev(name, `const s = ac.store.getState(); const w = s.windowOrder.find((id) => s.windows[id] && s.windows[id].kind === "main"); return w ? { active: s.windows[w].activeTabIds.default, tabs: s.windows[w].tabIds.map((id) => s.tabs[id]).filter((t) => t && !t.pin).map((t) => ({ id: t.id, url: t.url, page: t.page.kind, title: t.title })) } : { active: null, tabs: [] }`);

const HELPERS = `
const F = globalThis.__film;
const st = () => ac.store.getState();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (k) => 0.5 - 0.5 * Math.cos(Math.PI * k);
const note = (e) => F.events.push(Object.assign({ t: Date.now() }, e));
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const mainNumber = () => ac.engine.call("windows.list").then((ws) => ws.find((w) => w.hasRoot).window);
const numberOf = (which) => mainNumber().then((n) => ac.engine.call("windows.dev", { window: n, action: "subroles" })).then((list) => parse(list).find((w) => (which === "settings" ? w.title === "Settings" : w.subrole === "AXStandardWindow")).number);
const P = F.pointer;
const use = (which) => numberOf(which).then((n) => { P.n = n; P.win = which; });
const dw = (action) => ac.engine.call("windows.dev", { window: P.n, action });
const at = (x, y) => {
  P.x = x;
  P.y = y;
  note({ win: P.win, x, y });
  return (P.win === "main" ? ac.shell.devSetPointer("w1", { x, y }) : Promise.resolve()).then(() => dw("mouse:moved:" + x + "," + y));
};
const move = (x, y, ms) => {
  if (P.x === null) return at(x, y);
  const x0 = P.x;
  const y0 = P.y;
  const steps = Math.max(1, Math.round(ms / 16));
  const step = (i) => (i > steps ? Promise.resolve() : at(Math.round((x0 + (x - x0) * ease(i / steps)) * 10) / 10, Math.round((y0 + (y - y0) * ease(i / steps)) * 10) / 10).then(() => sleep(16)).then(() => step(i + 1)));
  return step(1);
};
const click = () => {
  note({ down: 1 });
  return dw("mouse:down:" + P.x + "," + P.y).then(() => sleep(90)).then(() => { note({ up: 1 }); return dw("mouse:up:" + P.x + "," + P.y); });
};
const hide = () => { note({ hide: 1 }); P.x = null; P.y = null; return P.win === "main" ? ac.shell.devSetPointer("w1", null) : Promise.resolve(); };
const typeText = (text, gap) => text.split("").reduce((p, ch) => p.then(() => dw("type:" + ch)).then(() => sleep(gap)), Promise.resolve());
const key = (label, flags, chars, code) => { note({ key: label }); return dw("keys:" + flags + ":" + chars + ":" + code); };
const mainState = () => { const s = st(); const w = s.windowOrder.find((id) => s.windows[id] && s.windows[id].kind === "main"); return w ? s.windows[w] : null; };
const rowY = (i) => ${ROW0} + ${ROW} * i;
`;
const act = (name, body, timeout = 90000) => ev(name, `${HELPERS}\n${body}`, timeout);

const RECORDER = (dir) => `
globalThis.__film = { on: true, frames: [], events: [], settings: false, pointer: { n: null, win: null, x: null, y: null } };
const F = globalThis.__film;
const loop = () => {
  if (!F.on) return;
  const s = ac.store.getState();
  const w = s.windowOrder.find((id) => s.windows[id] && s.windows[id].kind === "main");
  const win = w ? s.windows[w] : null;
  const active = win ? s.tabs[win.activeTabIds.default] : null;
  const tabs = win ? win.tabIds.map((id) => s.tabs[id]).filter((t) => t && !t.pin).map((t) => [t.id, t.page.kind]) : [];
  const n = F.frames.length;
  const t = Date.now();
  const settings = F.settings;
  Promise.all([
    w ? ac.shell.devSnapshotWindow(w, ${JSON.stringify(dir)} + "/m" + n + ".png").catch(() => false) : false,
    settings ? ac.shell.devSnapshotWindow("settings", ${JSON.stringify(dir)} + "/s" + n + ".png").catch(() => false) : false,
  ]).then(([m, sv]) => {
    F.frames.push({ n, t, m: !!m, s: !!sv, url: active ? active.url : null, active: active ? active.id : null, tabs });
    setTimeout(loop, 25);
  });
};
loop();
return true;
`;

function pageRecorder(name) {
  const shots = [];
  const conns = new Map();
  const lastHash = new Map();
  let on = true;
  let k = 0;
  const done = (async () => {
    while (on) {
      const began = Date.now();
      try {
        const targets = (await apps[name].targets()).filter((t) => t.type === "page" && /^https?:/.test(t.url));
        for (const target of targets) {
          if (!conns.has(target.id)) conns.set(target.id, await devtools(target));
          const c = conns.get(target.id);
          const visible = await c.eval("document.visibilityState", { timeout: 1500 }).catch(() => "hidden");
          if (visible !== "visible") continue;
          const t = Date.now();
          const shot = await c.send("Page.captureScreenshot", { format: "png" }, { timeout: 3000 }).catch(() => null);
          if (!shot) continue;
          const url = await c.eval("location.href", { timeout: 1500 }).catch(() => target.url);
          const hash = createHash("md5").update(shot.data).digest("hex");
          let file = lastHash.get(hash);
          if (!file) {
            file = `${name}/p${k++}.png`;
            fs.writeFileSync(join(footage, file), Buffer.from(shot.data, "base64"));
            lastHash.set(hash, file);
          }
          shots.push({ t, url, file });
        }
      } catch (e) {
        if (on) log(name, "page shot", e.message);
      }
      await sleep(Math.max(40, 160 - (Date.now() - began)));
    }
    for (const c of conns.values()) c.close();
  })();
  return { shots, stop: () => ((on = false), done) };
}

const results = {};
const pages = {};
try {
  await Promise.all([start("A"), start("B")]);
  results.turnOn = await ev("A", `return acSync.turnOnSync(${JSON.stringify(folder)})`);
  await syncNow("A");
  const phrase = (await ev("A", "return acSync.native.recoveryWords()")).join(" ");
  results.join = await ev("B", `return acSync.enterRecoveryPhrase(${JSON.stringify(folder)}, ${JSON.stringify(phrase)})`);
  await until("B links Personal", () => ev("B", `return !!acSync.doc().profiles.default?.enabled && !!acSync.doc().scopes["p:" + acSync.doc().profiles.default.syncId]?.joined`), ["B", "A"]);
  await until("both pages load", async () => (await tabsOf("A")).tabs.every((t) => t.page === "loaded") && (await tabsOf("B")).tabs.every((t) => t.page === "loaded"), [], 60000);
  await ev("A", `ac.openSettings("sync"); return true`);
  await sleep(3500);

  for (const name of ["A", "B"]) await ev(name, RECORDER(join(footage, name)));
  await act("A", "F.settings = true; return true;");
  for (const name of ["A", "B"]) pages[name] = pageRecorder(name);
  await sleep(1200);
  mark("start");
  await sleep(1000);

  await act("A", `return use("settings").then(() => at(560, 540)).then(() => sleep(300)).then(() => move(${TOGGLE[0]}, ${TOGGLE[1]}, 750)).then(() => sleep(250)).then(() => click()).then(() => true);`);
  mark("toggle");
  results.toggled = await ev("A", "return !!ac.store.getState().profiles.default.syncTabs");
  await sleep(1300);
  await act("A", `return hide().then(() => numberOf("settings")).then((n) => ac.engine.call("windows.dev", { window: n, action: "performClose" })).then(() => { F.settings = false; return true; });`);
  mark("settingsClosed");
  await sleep(800);

  mark("mergeStart");
  await until("open tabs merge", async () => {
    const a = await tabsOf("A");
    const b = await tabsOf("B");
    return a.tabs.some((t) => t.id === "mac") && b.tabs.some((t) => t.id === "sourdough");
  }, ["A", "B"]);
  mark("merged");
  results.merged = { A: await tabsOf("A"), B: await tabsOf("B") };
  await sleep(1800);

  mark("openStart");
  for (const [i, text] of TYPED.entries()) {
    await act("A", `const row = rowY(mainState().tabIds.length); return use("main").then(() => at(${i ? 640 : 700}, ${i ? 520 : 470})).then(() => sleep(250)).then(() => move(120, row, 700)).then(() => sleep(200)).then(() => click()).then(() => sleep(250)).then(() => hide()).then(() => sleep(500)).then(() => typeText(${JSON.stringify(text)}, 55)).then(() => sleep(350)).then(() => key("Return", 0, "\\r", 36)).then(() => true);`);
    mark(`enter${i + 1}`);
    await until(`tab ${i + 1} loads on A`, async () => {
      const a = await tabsOf("A");
      const t = a.tabs.find((x) => x.id === a.active);
      return t && t.url.includes(i ? "github.com" : "Espresso") && t.page === "loaded" && t.title && !/^New Tab$/.test(t.title);
    }, [], 30000);
    mark(`loaded${i + 1}`);
    await sleep(i ? 1600 : 900);
  }
  mark("opened");
  const opened = (await tabsOf("A")).tabs.filter((t) => /Espresso|github/.test(t.url)).map((t) => t.id);
  results.opened = opened;
  await syncNow("A");
  const bBefore = await tabsOf("B");
  await until("A's new tabs reach B", async () => {
    const b = await tabsOf("B");
    return opened.every((id) => b.tabs.some((t) => t.id === id));
  }, ["B", "A"]);
  mark("arrived");
  const bAfter = await tabsOf("B");
  results.arrival = { activeBefore: bBefore.active, activeAfter: bAfter.active, tabs: bAfter.tabs };
  log("B after arrival", JSON.stringify(results.arrival));
  await sleep(2600);

  const espresso = bAfter.tabs.findIndex((t) => /Espresso/.test(t.url));
  results.closeIndex = espresso;
  await act("B", `const y = rowY(${espresso}); return use("main").then(() => at(720, 430)).then(() => sleep(300)).then(() => move(150, y, 750)).then(() => sleep(600)).then(() => move(${SIDEBAR - 16}, y, 320)).then(() => sleep(300)).then(() => click()).then(() => sleep(400)).then(() => hide()).then(() => true);`);
  mark("closeB");
  results.bAfterClose = await tabsOf("B");
  await sleep(700);
  await syncNow("B");
  await until("B's close reaches A", async () => !(await tabsOf("A")).tabs.some((t) => /Espresso/.test(t.url)), ["A", "B"]);
  mark("goneA");
  results.aAfterClose = await tabsOf("A");
  await sleep(2400);

  const closeChars = await act("A", `return use("main").then(() => Promise.all(["W", "w"].map((c) => dw("reserved:${CMD | SHIFT}:" + c + ":13").then((id) => [c, id])))).then((all) => all);`);
  results.closeChars = closeChars;
  const chars = closeChars.find(([, id]) => /closeWindow/i.test(id))?.[0];
  const tabsBefore = (await tabsOf("A")).tabs.length;
  if (chars) await act("A", `return use("main").then(() => key("⇧⌘W", ${CMD | SHIFT}, ${JSON.stringify(chars ?? "W")}, 13)).then(() => true);`);
  await sleep(900);
  if ((await ev("A", "return Object.values(ac.store.getState().windows).filter((w) => w.kind === 'main').length")) > 0) {
    results.closeFallback = { chars, tabsBefore, tabsAfter: (await tabsOf("A")).tabs.length };
    throw new Error(`⇧⌘W didn't close A's window: ${JSON.stringify(results.closeFallback)}`);
  }
  mark("closedA");
  results.aWindows = await ev("A", "return Object.keys(ac.store.getState().windows).length");
  for (const n of ["A", "B", "A", "B"]) await syncNow(n);
  mark("kept");
  results.bKept = await tabsOf("B");
  await sleep(2400);
  mark("end");
} catch (e) {
  results.error = e.stack;
  log("ERROR", e.stack);
} finally {
  const timeline = { window: WINDOW, settingsWindow: { w: 820, h: 640 }, sidebar: SIDEBAR, row0: ROW0, row: ROW };
  for (const name of ["A", "B"]) {
    if (pages[name]) await pages[name].stop();
    let film = null;
    try {
      await ev(name, "globalThis.__film.on = false; return true", 10000);
      await sleep(600);
      film = await ev(name, "const F = globalThis.__film; return { frames: F.frames, events: F.events }", 30000);
    } catch (e) {
      log(name, "recorder", e.message);
    }
    if (film) timeline[name] = { ...film, pages: pages[name]?.shots ?? [] };
  }
  for (const [name, app] of Object.entries(apps)) {
    try {
      log(name, "quit", JSON.stringify(await app.quit()));
    } catch (e) {
      log(name, "quit failed", e.message);
    }
  }
  const t0 = marks.start ?? 0;
  const rel = (t) => Math.round(t - t0) / 1000;
  const seen = new Map();
  const dedupe = (name, file) => {
    const path = join(footage, name, file);
    if (!fs.existsSync(path)) return null;
    const hash = createHash("md5").update(fs.readFileSync(path)).digest("hex");
    const kept = seen.get(hash);
    if (kept) {
      fs.rmSync(path);
      return kept;
    }
    seen.set(hash, `${name}/${file}`);
    return `${name}/${file}`;
  };
  const out = { ...timeline, marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, rel(v)])), results };
  for (const name of ["A", "B"]) {
    const film = timeline[name];
    if (!film) continue;
    out[name] = {
      frames: film.frames.filter((f) => f.t >= t0 - 1500).map((f) => [rel(f.t), f.m ? dedupe(name, `m${f.n}.png`) : null, f.s ? dedupe(name, `s${f.n}.png`) : null, f.url, f.tabs.map(([id, kind]) => (kind === "idle" ? `${id}*` : id))]),
      events: film.events.map((e) => ({ ...e, t: rel(e.t) })),
      pages: film.pages.map((p) => [rel(p.t), p.url, p.file]),
    };
    for (const f of fs.readdirSync(join(footage, name))) {
      const n = /^[ms](\d+)\.png$/.exec(f);
      if (n && !film.frames.some((fr) => fr.n === Number(n[1]) && fr.t >= t0 - 1500)) fs.rmSync(join(footage, name, f));
    }
  }
  fs.writeFileSync(timelineFile, JSON.stringify(out));
  log("timeline", timelineFile, JSON.stringify(out.marks));
  log("results", JSON.stringify(results, null, 1));
  process.exit(results.error ? 1 : 0);
}
