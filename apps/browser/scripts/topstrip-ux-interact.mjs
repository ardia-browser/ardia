import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { session as sessionOf } from "../../../scripts/lib/instance.mjs";

const WIDTH = 1280;
const HEIGHT = 640;
const DOUBLE_CLICK_GAP_MS = 200;

function makeMeasure(ctx, inst, out) {
  let shot = 0;
  return async function measure(id, label, { hits = true } = {}) {
    const png = join(out, `.m-${label}-${shot++}.png`);
    const data = await inst.eval(
      `${ctx.HELPERS}
const id = ${JSON.stringify(id)};
const s = st();
const w = s.windows[id];
return D.devSnapshotWindow(id, ${JSON.stringify(png)}, false).then((ok) => D.devSetWindowFrame(id, [40 + Object.keys(s.windows).indexOf(id) * 11, 60 + Object.keys(s.windows).indexOf(id) * 7, w.frame[2], ${HEIGHT}]))
  .then((frame) => ${hits} ? nativeOf(frame).then((n) => hitRow(n, Math.round(frame[2]), ${21})) : [])
  .then((hits) => {
    const order = stripOrder(id);
    return { codes: hits.map(classify).join(""), order, loose: order.filter((t) => !s.tabs[t].pin), pins: order.filter((t) => s.tabs[t].pin),
      active: w.activeTabIds[w.profileId], favicons: Object.fromEntries(order.map((t) => [t, s.tabs[t].favicon])), discarded: [], width: w.frame[2] };
  });`,
      { timeout: 120000 },
    );
    const img = ctx.readPng(png);
    rmSync(png, { force: true });
    if (!hits) data.codes = "S".repeat(Math.round(data.width));
    const m = ctx.analyse(img, img.width / data.width, data, data.width);
    const favX = Object.fromEntries(m.detail.favs.filter((f) => f[2]).map(([t, x]) => [t, x]));
    return { ...m, favX, active: data.active, count: data.loose.length, img };
  };
}

function savePng(ctx, img, path, height = 48) {
  const h = Math.min(height, img.height);
  writeFileSync(path, ctx.encodePng({ width: img.width, height: h, rgba: Buffer.from(img.rgba.subarray(0, img.width * 4 * h)) }));
}

async function burst(ctx, inst, id, dir, ms, action) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shots = await inst.eval(
    `${ctx.HELPERS}
const id = ${JSON.stringify(id)};
const shots = [];
const t0 = performance.now();
let k = 0, acted = false;
const shoot = () => {
  const at = performance.now() - t0;
  if (at > ${ms}) return Promise.resolve(shots);
  const name = ${JSON.stringify(dir)} + "/full" + String(k++).padStart(5, "0") + ".png";
  return D.devSnapshotWindow(id, name, false).then(() => { shots.push([name, Math.round(at)]); if (!acted && at >= 60) { acted = true; return Promise.resolve().then(() => { ${action} }); } }).then(() => wait(Math.max(0, 25 - ((performance.now() - t0) - at)))).then(shoot);
};
return shoot();`,
    { timeout: 90000 },
  );
  for (const [name] of shots) {
    const img = ctx.readPng(name);
    const h = Math.min(48, img.height);
    writeFileSync(name.replace("/full", "/f"), ctx.encodePng({ width: img.width, height: h, rgba: Buffer.from(img.rgba.subarray(0, img.width * 4 * h)) }));
    rmSync(name, { force: true });
  }
  return shots.map((s) => s[1]);
}

function stripFrames(dir, outPng, every = 2) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  if (!files.length) return 0;
  const pick = files.filter((_, i) => i % every === 0).slice(0, 24);
  const args = ["-y", "-loglevel", "error", ...pick.flatMap((f) => ["-i", join(dir, f)]), "-filter_complex", `${pick.map((_, i) => `[${i}]`).join("")}vstack=inputs=${pick.length}`, outPng];
  if (pick.length === 1) execFileSync("cp", [join(dir, pick[0]), outPng]);
  else execFileSync("ffmpeg", args);
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "60", "-pattern_type", "glob", "-i", join(dir, "f*.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p", outPng.replace(/\.png$/, ".mp4")]);
  } catch {}
  return files.length;
}

function profileSession(port) {
  const tabs = [
    ...Array.from({ length: 60 }, (_, i) => ({ id: `pw-t${i}`, windowId: "pw", profileId: "default", url: `http://127.0.0.1:${port}/page/pw/${i}`, title: `Tab ${i}`, favicon: `http://127.0.0.1:${port}/fav/${i}.png`, lastActiveAt: 2 + i })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `pw-w${i}`, windowId: "pw", profileId: "work", url: `http://127.0.0.1:${port}/page/pww/${i}`, title: `Work ${i}`, favicon: null, lastActiveAt: 2 + i })),
  ];
  const s = sessionOf({ profiles: ["Personal", { id: "work", name: "Work" }], windows: [{ id: "pw", frame: [60, 60, WIDTH, HEIGHT], tabLayout: "top", tabIds: tabs.map((t) => t.id), activeTabIds: { default: "pw-t5", work: "pw-w0" } }], tabs, settings: { tabLayout: "top" } });
  s.windows[0].tabLayout = "top";
  return s;
}

export async function runInteractions(ctx) {
  const out = ctx.out;
  mkdirSync(join(out, "frames"), { recursive: true });
  const only = ctx.flag("only") ? new RegExp(ctx.flag("only")) : null;
  const server = await ctx.startServer();
  const port = server.address().port;
  const inst = await ctx.launch(ctx.app, { data: join(out, ".data", "interact"), fresh: true, session: ctx.familySession("counts", port), onboarded: true, startTimeout: 120000 });
  const run = (body, timeout = 60000) => inst.eval(`${ctx.HELPERS}\n${body}`, { timeout });
  const measure = makeMeasure(ctx, inst, out);
  const results = {};
  const record = (name, value) => {
    results[name] = value;
    console.log(`${name.padEnd(34)} ${JSON.stringify(value, (k, v) => (k === "img" ? undefined : v))}`);
    writeFileSync(join(out, "interact.json"), JSON.stringify(results, (k, v) => (k === "img" ? undefined : v), 1));
  };
  const want = (name) => !only || only.test(name);
  const prepare = (id, width, selIndex) =>
    run(`const id = ${JSON.stringify(id)}; const loose = stripOrder(id).filter((t) => !st().tabs[t].pin);
      st().updateSettings({ appearance: "dark" });
      ac.actions.switchToTab(loose[${selIndex === "mid" ? "Math.floor(loose.length / 2)" : selIndex}]);
      return D.devSetWindowFrame(id, [40 + Object.keys(st().windows).indexOf(id) * 11, 60 + Object.keys(st().windows).indexOf(id) * 7, ${width}, ${HEIGHT}])
        .then(() => D.devSetPointer(id, ${width} / 2, 400, true)).then(() => wait(1200)).then(() => frames(3)).then(() => loose.length);`);
  const command = (id, command, arg = null) => run(`ac.runCommand({ command: ${JSON.stringify(command)}, arg: ${JSON.stringify(arg)}, windowId: ${JSON.stringify(id)} }); return wait(900).then(() => frames(3)).then(() => st().windows[${JSON.stringify(id)}].activeTabIds.default);`);
  try {
    await run(`return wait(4000);`);

    if (want("reveal")) {
      await prepare("c120", WIDTH, "mid");
      const frames = join(out, "frames", "reveal-far-left");
      await burst(ctx, inst, "c120", frames, 900, `const loose = stripOrder("c120"); ac.actions.switchToTab(loose[3]);`);
      const n = stripFrames(frames, join(out, "frames", "reveal-far-left.png"));
      await run(`return wait(400);`);
      const far = await measure("c120", "reveal");
      const rows = { menuPickFarLeft: far.selInView, frames: n };
      rows.cmd1 = (await command("c120", "selectTab", "1"), (await measure("c120", "cmd1")).selInView);
      rows.cmd9 = (await command("c120", "selectLastTab"), (await measure("c120", "cmd9")).selInView);
      await prepare("c120", WIDTH, 50);
      const steps = [];
      for (let i = 0; i < 14; i++) {
        await command("c120", "nextTab");
        const m = await measure("c120", `next${i}`, { hits: i === 13 });
        steps.push(m.favX[(await run(`return st().windows.c120.activeTabIds.default;`)).split("-").pop()] !== undefined ? 1 : 0);
      }
      rows.nextTab14 = steps;
      await prepare("c120", WIDTH, 100);
      rows.prevTab = [];
      for (let i = 0; i < 6; i++) {
        await command("c120", "previousTab");
        const m = await measure("c120", `prev${i}`, { hits: false });
        rows.prevTab.push(m.favX[(await run(`return st().windows.c120.activeTabIds.default;`)).split("-").pop()] !== undefined ? 1 : 0);
      }
      record("reveal", rows);
    }

    if (want("newtab")) {
      await prepare("c60", WIDTH, "mid");
      const before = await measure("c60", "nt0");
      const frames = join(out, "frames", "new-tab-full");
      await burst(ctx, inst, "c60", frames, 900, `ac.runCommand({ command: "newTab", arg: null, windowId: "c60" });`);
      stripFrames(frames, join(out, "frames", "new-tab-full.png"));
      await run(`return wait(500);`);
      const after = await measure("c60", "nt1");
      savePng(ctx, after.img, join(out, "frames", "new-tab-full-after.png"));
      const shape = after.detail.selSpan;
      record("newTabFull", { selShapeInView: shape[0] > after.detail.viewport[0] + 1 && shape[1] < after.detail.viewport[1] - 1 && shape[1] - shape[0] > 20 ? 1 : 0, newTabButton: after.newTab, beforeNewTab: before.newTab, selSpan: shape });
      await run(`ac.runCommand({ command: "closeTab", arg: null, windowId: "c60" }); return wait(800);`);
    }

    if (want("background")) {
      await prepare("c60", WIDTH, "mid");
      const before = await measure("c60", "bg0", { hits: false });
      await run(`const cur = st().windows.c60.activeTabIds.default; st().newTab("c60", { url: "http://127.0.0.1:${port}/page/c60/2", background: true, openerId: cur }); return wait(900);`);
      const after = await measure("c60", "bg1", { hits: false });
      savePng(ctx, before.img, join(out, "frames", "background-tab-before.png"));
      savePng(ctx, after.img, join(out, "frames", "background-tab-after.png"));
      record("backgroundTab", { selectedShift: after.detail.selSpan[0] - before.detail.selSpan[0], selInViewAfter: after.detail.selSpan[0] >= 0 ? 1 : 0, selTitleBefore: before.selTitlePt });
    }

    if (want("revealYieldsToScroll")) for (const [name, dy] of [["", -4], ["Precise", -0.6]]) {
      await prepare("c120", WIDTH, "mid");
      const r = await run(`const w = st().windows.c120; const loose = stripOrder("c120").filter((t) => !st().tabs[t].pin);
        const steps = Array.from({ length: 30 }, (_, i) => ({ phase: "wheel", dy: ${dy}, timestampMs: i * 16 }));
        const page = globalThis.topStripPages["c120|default"];
        const before = Math.round(page.scroll().x);
        return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, w.frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame)).then((n) => {
          setTimeout(() => ac.actions.switchToTab(loose[3]), 60);
          return globalThis.expo.modules.ArdiaSwipe.devSimulate(640, 21, n, steps, true);
        }).then(() => wait(250)).then(() => { const atEnd = Math.round(page.scroll().x); return wait(1200).then(() => {
          const sc = page.scroll(); const chip = page.chips().find((c) => c.id === loose[3]);
          return { before, afterWheel: atEnd, settled: Math.round(sc.x), selectedShown: chip.start >= sc.x - 1 && chip.end <= sc.x + sc.viewport + 1, active: st().windows.c120.activeTabIds.default.split("-").pop() };
        }); });`, 60000);
      record(`revealYieldsToScroll${name}`, { ...r, dy, snappedBack: r.settled !== r.afterWheel });
    }

    if (want("closeGhostScrolled")) {
      const trials = [];
      for (const settle of [1, 2, 3, 4]) {
        await prepare("c120", WIDTH, "mid");
        const m0 = await measure("c120", "cg0", { hits: false });
        const scroll = await run(`return Math.round(globalThis.topStripPages["c120|default"].scroll().x);`);
        const target = m0.detail.favs.find(([t, x, full]) => full && /^t\d+$/.test(t) && t !== m0.active.split("-").pop() && x > 400 && x < 1000);
        const colour = ctx.COLOURS[Number(target[0].slice(1))];
        const shot = join(out, "frames", `close-ghost-scrolled-${settle}.png`);
        await run(`st().closeTabs(["c120-${target[0]}"]); return frames(${settle}).then(() => D.devSnapshotWindow("c120", ${JSON.stringify(shot)}, false));`);
        const img = ctx.readPng(shot);
        const k = img.width / WIDTH;
        const px = (x, y) => { const i = (Math.round(y * k) * img.width + Math.round(x * k)) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };
        const far = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
        const bg = px(target[1] - 6, 6);
        let ink = 0;
        for (let y = 12; y < 30; y++) for (let x = target[1] - 2; x < target[1] + 18; x++) { const c = px(x, y); if (far(c, colour) < far(c, bg)) ink++; }
        trials.push({ settle, scroll, target: target[0], ink });
        await run(`ac.runCommand({ command: "reopenClosedTab", arg: null, windowId: "c120" }); return wait(1200);`);
      }
      record("closeGhostScrolled", { seen: trials.filter((t) => t.ink > 40).length, of: trials.length, trials });
    }

    if (want("groupEdgeDrag")) for (const selectDuring of [false, true]) {
      await prepare("c120", WIDTH, 0);
      const group = await run(`const id = st().createGroup(["c120-t4", "c120-t5", "c120-t6", "c120-t7"], { name: "Edge" }); st().updateGroup(id, { collapsed: false }); return wait(1200).then(() => id);`);
      const before = await run(`const p = globalThis.topStripPages["c120|default"]; const sc = p.scroll(); const first = p.chips().find((c) => c.id === "c120-t4");
        return { x: Math.round(first.start - sc.x + 71 - 14), scroll: Math.round(sc.x), max: Math.round(sc.content - sc.viewport), at: st().windows.c120.tabIds.indexOf("c120-t4"), viewport: Math.round(sc.viewport) };`);
      const edge = before.viewport + 60;
      const pts = [[before.x, 21], [before.x, 21], [before.x + 12, 21], [before.x + 60, 21]];
      for (let x = before.x + 60; x < edge; x += 60) pts.push([x, 21]);
      for (let i = 0; i < 24; i++) pts.push([edge, 21]);
      await run(`const w = st().windows.c120; return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, w.frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame))
        .then((n) => { if (${selectDuring}) setTimeout(() => ac.actions.switchToTab("c120-t60"), 700); return ac.engine.call("windows.dev", { window: n, action: "drag:${pts.map((p) => p.join(",")).join(";")}" }); }).then(() => wait(${pts.length * 12 * 16 + 1500}));`, 120000);
      const after = await run(`const p = globalThis.topStripPages["c120|default"]; const sc = p.scroll(); const chip = p.chips().find((c) => c.id === "c120-t60");
        return { scroll: Math.round(sc.x), at: st().windows.c120.tabIds.indexOf("c120-t4"), active: st().windows.c120.activeTabIds.default.split("-").pop(), t60Shown: chip.start >= sc.x - 1 && chip.end <= sc.x + sc.viewport + 1 };`);
      record(selectDuring ? "groupEdgeDragSelect" : "groupEdgeDrag", { fromIndex: before.at, toIndex: after.at, movedTabs: after.at - before.at, scrolledFrom: before.scroll, scrolledTo: after.scroll, max: before.max, grabX: before.x, ...(selectDuring ? { active: after.active, t60Shown: after.t60Shown } : {}) });
      await run(`st().ungroup(${JSON.stringify(group)}); return wait(600);`);
    }

    if (want("closeUnderPointer")) {
      for (const [id, width, at] of [["c60", WIDTH], ["c30", WIDTH], ["c15", 900], ["c15", 900, "left"], ["c15", 900, "right"], ["c15", 900, "selected"], ["c15", 1728], ["c15", 1728, "end"]]) {
        await prepare(id, width, "mid");
        const m0 = await measure(id, "cp0");
        const visible = m0.detail.tabs.filter(([t, a, b]) => a > m0.detail.viewport[0] + 30 && b < m0.detail.viewport[1] - 30 && t !== m0.active.split("-").pop());
        const selected = m0.detail.tabs.find(([t]) => t === m0.active.split("-").pop());
        const side = (left) => visible.filter(([, a]) => (selected ? (left ? a < selected[1] : a > selected[1]) : false));
        const middle = (list) => list[Math.floor(list.length / 2)] ?? list[0];
        const target = at === "end" ? m0.detail.tabs.filter(([t]) => t !== m0.active.split("-").pop()).at(-1)
          : at === "left" ? middle(side(true)) : at === "right" ? middle(side(false)) : at === "selected" ? selected : middle(visible);
        if (!target) {
          record(`closeUnderPointer.${id}`, { error: "no tab" });
          continue;
        }
        const x = target[2] - 6 - 11;
        const res = await run(`const id = ${JSON.stringify(id)};
          return D.devSetPointer(id, ${x}, 21, true).then(() => wait(450)).then(() => D.devSetWindowFrame(id, [40 + Object.keys(st().windows).indexOf(id) * 11, 60 + Object.keys(st().windows).indexOf(id) * 7, ${width}, ${HEIGHT}]))
            .then((frame) => nativeOf(frame)).then((n) => {
              const hitAt = () => ac.engine.call("windows.dev", { window: n, action: "hit:${x},21" });
              const closes = [];
              let chain0 = null;
              const step = (k) => k >= 5 ? Promise.resolve() : hitAt().then((h) => {
                if (k === 0) chain0 = h;
                const count = stripOrder(id).length;
                closes.push({ chain: h, sameAsClose: h === chain0 });
                return ac.engine.call("windows.dev", { window: n, action: "click:${x},21" }).then(() => wait(650)).then(() => { closes[k].closed = count - stripOrder(id).length; }).then(() => step(k + 1));
              });
              return step(0).then(() => hitAt()).then((h) => { closes.push({ chain: h, sameAsClose: h === chain0, final: true }); return closes; });
            });`, 90000);
        const isClose = (res[0].closed ?? 0) > 0;
        const firstClose = res.findIndex((c) => (c.closed ?? 0) > 0);
        const landed = firstClose < 0 ? 0 : res.slice(firstClose + 1).filter((c) => (c.closed ?? 0) > 0).length;
        const closed = res.reduce((n, c) => n + (c.closed ?? 0), 0);
        const mAfter = await measure(id, "cp1", { hits: false });
        savePng(ctx, mAfter.img, join(out, "frames", `close-under-pointer-${id}.png`));
        record(`closeUnderPointer.${id}-${width}${at ? "-" + at : ""}`, { closedOf5: closed, closesAfterFirst: landed, startedOnClose: isClose, target: target[0], x, steps: res.map((c) => [c.closed ?? null, c.chain.slice(0, 40)]) });
        await run(`const id = ${JSON.stringify(id)}; return D.devSetPointer(id, ${width} / 2, 400, true).then(() => wait(700)).then(() => { const need = ${Number(id.slice(1))} - stripOrder(id).filter((t) => !st().tabs[t].pin).length; for (let i = 0; i < need; i++) ac.runCommand({ command: "reopenClosedTab", arg: null, windowId: id }); return wait(1500); });`);
      }
    }

    if (want("doubleClickSelect")) {
      for (const at of ["left", "right"]) {
        await prepare("c15", 900, "mid");
        const m0 = await measure("c15", "dc0");
        const selected = m0.detail.tabs.find(([t]) => t === m0.active.split("-").pop());
        const visible = m0.detail.tabs.filter(([t, a, b]) => a > m0.detail.viewport[0] + 30 && b < m0.detail.viewport[1] - 30 && t !== m0.active.split("-").pop() && b - a < 60);
        const list = visible.filter(([, a]) => (selected ? (at === "left" ? a < selected[1] : a > selected[1]) : false));
        const target = list[Math.floor(list.length / 2)];
        if (!target) {
          record(`doubleClickSelect.${at}`, { error: "no tab" });
          continue;
        }
        const x = target[2] - 6 - 11;
        const res = await run(`const id = "c15";
          return D.devSetPointer(id, ${x}, 21, true).then(() => wait(450)).then(() => D.devSetWindowFrame(id, [40 + Object.keys(st().windows).indexOf(id) * 11, 60 + Object.keys(st().windows).indexOf(id) * 7, 900, ${HEIGHT}]))
            .then((frame) => nativeOf(frame)).then((n) => {
              const count = stripOrder(id).length;
              const click = () => ac.engine.call("windows.dev", { window: n, action: "click:${x},21" });
              return click().then(() => wait(${DOUBLE_CLICK_GAP_MS})).then(click).then(() => wait(900)).then(() => ({ closed: count - stripOrder(id).length, active: st().windows[id].activeTabIds.default }));
            });`, 60000);
        record(`doubleClickSelect.${at}`, { closed: res.closed, selected: res.active.split("-").pop(), target: target[0], x, gapMs: DOUBLE_CLICK_GAP_MS });
        await run(`const id = "c15"; return D.devSetPointer(id, 450, 400, true).then(() => wait(700)).then(() => { const need = 15 - stripOrder(id).filter((t) => !st().tabs[t].pin).length; for (let i = 0; i < need; i++) ac.runCommand({ command: "reopenClosedTab", arg: null, windowId: id }); return wait(1500); });`);
      }
    }

    if (want("closeEnds")) {
      const r = {};
      for (const end of ["start", "end"]) {
        await prepare("c30", WIDTH, end === "start" ? 0 : "loose.length - 1");
        const frames = join(out, "frames", `close-selected-${end}`);
        await burst(ctx, inst, "c30", frames, 700, `ac.runCommand({ command: "closeTab", arg: null, windowId: "c30" });`);
        stripFrames(frames, join(out, "frames", `close-selected-${end}.png`));
        await run(`return wait(500);`);
        const m = await measure("c30", `ce-${end}`);
        r[end] = { selInView: m.selInView, selTitlePt: m.selTitlePt, now: m.active };
      }
      record("closeSelectedAtEnds", r);
    }

    if (want("scroll")) {
      const r = {};
      for (const [kind, steps] of [
        ["wheelVertical", Array.from({ length: 6 }, () => ({ phase: "wheel", dy: -4 }))],
        ["wheelShift", Array.from({ length: 6 }, () => ({ phase: "wheel", dy: -4, shift: true }))],
        ["trackpadHorizontal", [{ phase: "began", dx: -8 }, ...Array.from({ length: 12 }, () => ({ phase: "changed", dx: -24 })), { phase: "ended", dx: 0 }, { phase: "momentumBegan", dx: -20 }, ...Array.from({ length: 10 }, (_, i) => ({ phase: "momentumChanged", dx: -18 + i * 1.6 })), { phase: "momentumEnded", dx: 0 }]],
        ["trackpadVertical", [{ phase: "began", dy: -8 }, ...Array.from({ length: 12 }, () => ({ phase: "changed", dy: -24 })), { phase: "ended", dy: 0 }]],
      ]) {
        await prepare("c120", WIDTH, "mid");
        const before = await measure("c120", `sc0-${kind}`, { hits: false });
        const sim = await run(`const w = st().windows.c120;
          return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, w.frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame))
            .then((n) => globalThis.expo.modules.ArdiaSwipe.devSimulate(640, 21, n, ${JSON.stringify(steps.map((s, i) => ({ ...s, timestampMs: i * 16 })))}, true)).then((r) => wait(900).then(() => r));`);
        const after = await measure("c120", `sc1-${kind}`, { hits: false });
        const common = Object.keys(before.favX).filter((t) => after.favX[t] !== undefined);
        const shift = common.length ? after.favX[common[0]] - before.favX[common[0]] : before.detail.tabs.length && after.detail.tabs.length ? NaN : 0;
        const firstBefore = before.detail.tabs[0]?.[0], firstAfter = after.detail.tabs[0]?.[0];
        r[kind] = { shiftPt: Number.isNaN(shift) ? `moved past (${firstBefore}→${firstAfter})` : shift, firstVisible: [firstBefore, firstAfter], sim: typeof sim === "object" ? Object.keys(sim ?? {}).slice(0, 4) : sim };
      }
      record("scroll", r);
    }

    if (want("edgeDrag")) {
      await prepare("c60", WIDTH, "mid");
      const m0 = await measure("c60", "ed0");
      const vis = m0.detail.tabs.filter(([, a]) => a > m0.detail.viewport[0] + 10);
      const grab = vis[1];
      const edge = m0.detail.viewport[1] - 6;
      const startX = Math.round((grab[1] + grab[2]) / 2);
      const pts = [[startX, 21], [startX + 12, 21], [startX + 60, 21]];
      for (let x = startX + 60; x < edge; x += 60) pts.push([x, 21]);
      for (let i = 0; i < 14; i++) pts.push([edge, 21]);
      const before = await run(`return stripOrder("c60").filter((t) => !st().tabs[t].pin).indexOf("c60-${grab[0]}");`);
      await run(`const w = st().windows.c60; return D.devSetWindowFrame("c60", [40 + Object.keys(st().windows).indexOf("c60") * 11, 60 + Object.keys(st().windows).indexOf("c60") * 7, w.frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame))
        .then((n) => ac.engine.call("windows.dev", { window: n, action: "drag:${pts.map((p) => p.join(",")).join(";")}" })).then(() => wait(${pts.length * 12 * 16 + 1200}));`, 120000);
      const after = await run(`const at = () => stripOrder("c60").filter((t) => !st().tabs[t].pin).indexOf("c60-${grab[0]}");
        const until = Date.now() + 6000; const poll = () => at() !== ${before} || Date.now() > until ? at() : wait(150).then(poll); return poll();`, 30000);
      const m1 = await measure("c60", "ed1", { hits: false });
      savePng(ctx, m1.img, join(out, "frames", "edge-drag-after.png"));
      record("edgeDrag", { from: before, to: after, movedSlots: after - before, lastVisibleBefore: vis.at(-1)?.[0], grabbed: grab[0], startX, edge, viewport: m0.detail.viewport });
    }

    if (want("resize")) {
      await prepare("c120", 1728, 70);
      const wide = await measure("c120", "rs0");
      await run(`const w = st().windows.c120; return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, 900, ${HEIGHT}]).then(() => wait(1200));`);
      const narrow = await measure("c120", "rs1");
      await run(`return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, 1728, ${HEIGHT}]).then(() => wait(1200));`);
      const back = await measure("c120", "rs2");
      record("resize", { wide: wide.selInView, narrow: narrow.selInView, back: back.selInView, identifiableWide: wide.identifiable, identifiableNarrow: narrow.identifiable });
    }

    if (want("hover")) {
      await prepare("c120", WIDTH, "mid");
      const m0 = await measure("c120", "hv0");
      const t = m0.detail.tabs.find(([id, a]) => a > m0.detail.viewport[0] + 200 && `c120-${id}` !== m0.active);
      const centre = Math.round((t[1] + t[2]) / 2);
      const r = await run(`return D.devSetPointer("c120", ${centre}, 21, true).then(() => wait(1100)).then(() => {
          const h = ac.stripHover.useStripHover.getState().hover;
          const w = st().windows.c120;
          return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, w.frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame))
            .then((n) => Promise.all([ac.engine.call("windows.dev", { window: n, action: "hit:${t[2] - 17},21" }), ac.engine.call("windows.dev", { window: n, action: "hit:${centre},21" })]))
            .then(([closeHit, centreHit]) => ({ card: !!h, closeHit, centreHit }));
        });`);
      const shot = await measure("c120", "hv1", { hits: false });
      savePng(ctx, shot.img, join(out, "frames", "hover-min-width.png"), 120);
      record("hoverMinWidth", { card: r.card, tabWidth: t[2] - t[1], closeChain: r.closeHit.slice(0, 90), centreChain: r.centreHit.slice(0, 90) });
      await run(`return D.devSetPointer("c120", 640, 400, true).then(() => wait(600));`);
    }

    const frameOf = (id) => `40 + Object.keys(st().windows).indexOf(${JSON.stringify(id)}) * 11, 60 + Object.keys(st().windows).indexOf(${JSON.stringify(id)}) * 7`;
    const nativeBody = (id) => `D.devSetWindowFrame(${JSON.stringify(id)}, [${frameOf(id)}, st().windows[${JSON.stringify(id)}].frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame))`;
    const runsIn = (codes) => { const out = []; let a = -1; for (let x = 0; x <= codes.length; x++) { const on = codes[x] === "T"; if (on && a < 0) a = x; if (!on && a >= 0) { out.push([a, x]); a = -1; } } return out; };
    const stripRuns = (id) => run(`return ${nativeBody(id)}.then((n) => hitRow(n, st().windows[${JSON.stringify(id)}].frame[2], 21)).then((h) => h.map(classify).join(""));`, 90000).then(runsIn);

    if (want("hoverScan")) {
      await prepare("c60", WIDTH, "mid");
      const m0 = await measure("c60", "hs0");
      const tabs = m0.detail.tabs.filter(([id, a]) => a > m0.detail.viewport[0] + 120 && `c60-${id}` !== m0.active);
      const xs = tabs.slice(2, 7).map(([, a, b]) => Math.round((a + b) / 2));
      const r = await run(`const xs = ${JSON.stringify(xs)};
        const shownFor = () => { const h = ac.stripHover.useStripHover.getState().hover; return h ? h.tabId : null; };
        const until = (pred, ms) => new Promise((res) => { const t0 = performance.now(); const tick = () => { if (pred()) return res(Math.round(performance.now() - t0)); if (performance.now() - t0 > ms) return res(null); requestAnimationFrame(tick); }; tick(); });
        const out = [];
        return D.devSetPointer("c60", 640, 400, true).then(() => wait(900)).then(() => {
          let chain = Promise.resolve();
          xs.forEach((x, i) => { chain = chain.then(() => { const before = shownFor(); return D.devSetPointer("c60", x, 21, true).then(() => until(() => shownFor() && shownFor() !== before, 3000)).then((ms) => out.push(ms)); }); });
          return chain.then(() => D.devSetPointer("c60", 640, 400, true)).then(() => wait(700)).then(() => out);
        });`, 60000);
      record("hoverScan", { firstCardMs: r[0], nextCardMs: r.slice(1), tabWidth: tabs[2] ? tabs[2][2] - tabs[2][1] : null });
    }

    if (want("closeRun")) {
      for (const n of [15, 30, 60, 120]) for (const pos of ["start", "mid", "end"]) {
        const id = `c${n}`;
        await prepare(id, WIDTH, pos === "start" ? 0 : pos === "end" ? "loose.length - 1" : "mid");
        const activeId = await run(`return st().windows.${id}.activeTabIds.default;`);
        const m = await measure(id, `cr-${n}-${pos}`);
        const runs = await stripRuns(id);
        const sel = runs.find(([a, b]) => a < m.detail.selSpan[1] && m.detail.selSpan[0] < b);
        if (!sel) { record(`closeRun.${n}-${pos}`, { error: "no selected run", selSpan: m.detail.selSpan }); continue; }
        const x = sel[1] - 6 - 11;
        const res = await run(`const id = ${JSON.stringify(id)};
          return D.devSetPointer(id, ${x}, 21, true).then(() => wait(500)).then(() => ${nativeBody(id)}).then((n) => {
            const hitAt = () => ac.engine.call("windows.dev", { window: n, action: "hit:${x},21" });
            const steps = []; let chain0 = null;
            const step = (k) => k >= 5 ? Promise.resolve() : hitAt().then((h) => {
              if (k === 0) chain0 = h;
              const count = stripOrder(id).length, was = st().windows[id].activeTabIds.default;
              steps.push({ before: h, sameAsClose: h === chain0 });
              return ac.engine.call("windows.dev", { window: n, action: "click:${x},21" }).then(() => wait(700)).then(() => {
                steps[k].closed = count - stripOrder(id).length; steps[k].selectedAfter = st().windows[id].activeTabIds.default; steps[k].was = was;
                const page = globalThis.topStripPages && globalThis.topStripPages[id + "|default"];
                if (page) { const sc = page.scroll(); const under = page.chips().filter((c) => c.start - sc.x <= ${x} - 86 + 15 && c.end - sc.x >= ${x} - 86 - 15).map((c) => [c.id.split("-").pop(), Math.round(c.start - sc.x), Math.round(c.end - c.start)]); steps[k].under = under; steps[k].scroll = Math.round(sc.x); }
              }).then(() => step(k + 1));
            });
            return step(0).then(() => hitAt()).then((h) => { steps.push({ before: h, sameAsClose: h === chain0, final: true }); return { chain0, steps }; });
          });`, 90000);
        const closed = res.steps.reduce((a, c) => a + (c.closed ?? 0), 0);
        const startedOnClose = (res.steps[0].closed ?? 0) > 0;
        const firstClose = res.steps.findIndex((c) => (c.closed ?? 0) > 0);
        const landed = firstClose < 0 ? 0 : res.steps.slice(firstClose + 1).filter((c) => (c.closed ?? 0) > 0).length;
        const order = await run(`return stripOrder(${JSON.stringify(id)});`);
        const neighbourSelected = res.steps.filter((c) => c.closed).map((c) => c.selectedAfter);
        record(`closeRun.${n}-${pos}`, { closedOf5: closed, closesAfterFirst: landed, startedOnClose, selectedAfter: neighbourSelected.map((t) => t?.split("-").pop()), x, selRun: sel, steps: res.steps.map((c) => [c.closed ?? null, c.before.slice(0, 30), c.under, c.scroll, c.selectedAfter?.split("-").pop()]), orderAround: order.slice(Math.max(0, order.indexOf(activeId) - 3), order.indexOf(activeId) + 8).map((t) => t.split("-").pop()) });
        await run(`const id = ${JSON.stringify(id)}; return D.devSetPointer(id, 640, 400, true).then(() => wait(600)).then(() => { const need = ${n} - stripOrder(id).filter((t) => !st().tabs[t].pin).length; for (let i = 0; i < need; i++) st().newTab(id, { url: "http://127.0.0.1:${port}/page/" + id + "/" + (200 + i), background: true }); return wait(900); });`);
      }
    }

    if (want("middleClick")) {
      await prepare("c60", WIDTH, "mid");
      const m = await measure("c60", "mc0");
      const t = m.detail.tabs.find(([tid, a]) => a > m.detail.viewport[0] + 150 && `c60-${tid}` !== m.active);
      const cx = Math.round((t[1] + t[2]) / 2);
      const r = await run(`const before = stripOrder("c60").length;
        return ${nativeBody("c60")}.then((n) => ac.engine.call("windows.dev", { window: n, action: "mouse:otherdown:${cx},21" }).then(() => wait(60)).then(() => ac.engine.call("windows.dev", { window: n, action: "mouse:otherup:${cx},21" })))
          .then(() => wait(700)).then(() => ({ closed: before - stripOrder("c60").length, stillThere: stripOrder("c60").includes("c60-${t[0]}") }));`);
      record("middleClickCompact", { ...r, tabWidth: t[2] - t[1] });
    }

    if (want("switchMotion")) {
      await prepare("c60", WIDTH, "mid");
      const m = await measure("c60", "sm0");
      const selIdx = Number(m.active.split("-t").pop());
      const target = m.detail.tabs.find(([tid]) => Number(tid.slice(1)) === selIdx + 5);
      const between = selIdx + 3;
      const dir = join(out, "frames", "switch-motion");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const cx = Math.round((target[1] + target[2]) / 2);
      await burst(ctx, inst, "c60", dir, 900, `return ${nativeBody("c60")}.then((n) => ac.engine.call("windows.dev", { window: n, action: "click:${cx},21" }));`);
      const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
      const colour = ctx.COLOURS[between], colourT = ctx.COLOURS[selIdx + 5];
      const xOf = (img, c) => { let min = Infinity; for (let y = 13; y < 30; y++) for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 4; if (Math.abs(img.rgba[o] - c[0]) <= 12 && Math.abs(img.rgba[o + 1] - c[1]) <= 12 && Math.abs(img.rgba[o + 2] - c[2]) <= 12) min = Math.min(min, x); } return min === Infinity ? null : min; };
      const track = files.map((f) => { const img = ctx.readPng(join(dir, f)); return [xOf(img, colour), xOf(img, colourT)]; });
      const path = track.map((t) => t[0]).filter((v) => v !== null);
      const jumps = path.slice(1).map((v, i) => Math.abs(v - path[i]));
      const moving = jumps.filter((j) => j >= 0.5).length;
      stripFrames(dir, join(out, "frames", "switch-motion.png"), 2);
      record("switchMotion", { neighbourMovePt: path.length ? path.at(-1) - path[0] : null, framesMoving: moving, maxJumpPerFramePt: jumps.length ? Math.max(...jumps) : null, frames: files.length, path: path.slice(0, 40), clickedPath: track.map((t) => t[1]).slice(0, 40) });
    }

    if (want("wheel")) {
      const r = {};
      await prepare("c120", WIDTH, "mid");
      const pageOf = async () => { const sel = await run(`return st().tabs[st().windows.c120.activeTabIds.default].url;`); return inst.page(sel.split("127.0.0.1:")[1]); };
      let page = null;
      try { page = await pageOf(); } catch (e) { r.pageError = String(e.message); }
      const pageY = async () => (page ? page.eval("window.scrollY") : null);
      const sim = (x, y, steps) => run(`return ${nativeBody("c120")}.then((n) => globalThis.expo.modules.ArdiaSwipe.devSimulate(${x}, ${y}, n, ${JSON.stringify(steps)}, true)).then(() => wait(900));`, 30000);
      const cases = {
        verticalWheelOverStrip: [640, 21, Array.from({ length: 5 }, (_, i) => ({ phase: "wheel", dy: -3, dispatch: "app", timestampMs: i * 40 }))],
        verticalWheelOverPage: [640, 300, Array.from({ length: 5 }, (_, i) => ({ phase: "wheel", dy: -3, dispatch: "app", timestampMs: i * 40 }))],
        shiftWheelOverStrip: [640, 21, Array.from({ length: 5 }, (_, i) => ({ phase: "wheel", dy: -3, shift: true, dispatch: "app", timestampMs: i * 40 }))],
        trackpadHorizontalApp: [640, 21, [{ phase: "mayBegin", dx: 0 }, { phase: "began", dx: -6 }, ...Array.from({ length: 14 }, () => ({ phase: "changed", dx: -18 })), { phase: "ended", dx: 0 }, { phase: "momentumBegan", dx: -16 }, ...Array.from({ length: 12 }, (_, i) => ({ phase: "momentumChanged", dx: -14 + i })), { phase: "momentumEnded", dx: 0 }].map((s, i) => ({ ...s, dispatch: "app", timestampMs: i * 16 }))],
        preciseHorizontalOverStrip: [640, 21, Array.from({ length: 16 }, (_, i) => ({ phase: "none", dx: -18, dispatch: "app", timestampMs: i * 16 }))],
        preciseVerticalOverStrip: [640, 21, Array.from({ length: 16 }, (_, i) => ({ phase: "none", dy: -18, dispatch: "app", timestampMs: i * 16 }))],
        trackpadVerticalApp: [640, 21, [{ phase: "began", dy: -6 }, ...Array.from({ length: 14 }, () => ({ phase: "changed", dy: -18 })), { phase: "ended", dy: 0 }].map((s, i) => ({ ...s, dispatch: "app", timestampMs: i * 16 }))],
      };
      for (const [name, [x, y, steps]] of Object.entries(cases)) {
        await prepare("c120", WIDTH, "mid");
        if (page) await page.eval("window.scrollTo(0, 0)").catch(() => {});
        await run(`return wait(300);`);
        const before = await measure("c120", `wh0-${name}`, { hits: false });
        const y0 = await pageY().catch(() => null);
        await sim(x, y, steps);
        const after = await measure("c120", `wh1-${name}`, { hits: false });
        const y1 = await pageY().catch(() => null);
        const common = Object.keys(before.favX).filter((t) => after.favX[t] !== undefined);
        r[name] = { stripShiftPt: common.length ? after.favX[common[0]] - before.favX[common[0]] : "moved past every visible tab", pageScrollY: [y0, y1] };
      }
      record("wheel", r);
    }

    if (want("revealStale")) {
      await prepare("c60", WIDTH, "mid");
      const m = await measure("c60", "rs0");
      const t = m.detail.tabs.find(([tid, a]) => a > m.detail.viewport[0] + 400 && `c60-${tid}` !== m.active);
      const cx = Math.round((t[1] + t[2]) / 2);
      await run(`return D.devSetWindowFrame("c30", [${frameOf("c30")}, ${WIDTH}, ${HEIGHT}]).then(() => wait(600));`);
      const other = await measure("c30", "rs-other");
      const ox = Math.round((other.detail.selSpan[0] + other.detail.selSpan[1]) / 2);
      const r = await run(`const page = () => globalThis.topStripPages && globalThis.topStripPages["c60|default"];
        return ${nativeBody("c60")}.then((n) => ac.engine.call("windows.dev", { window: n, action: "click:${cx},21" }).then(() => wait(1500)).then(() => {
          const p = page(); if (!p) return { error: "no dev registry (round-1 code)" };
          const afterClick = p.scroll().x; p.scrollTo(Math.max(0, afterClick + 600)); return wait(800).then(() => {
            const handScrolled = p.scroll().x;
            return D.devSetPointer("c60", 640, 400, true).then(() => wait(300)).then(() => ${nativeBody("c30")}).then((o) => ac.engine.call("windows.dev", { window: o, action: "click:${ox},21" })).then(() => wait(1500)).then(() => ({ afterClick, handScrolled, afterOtherWindowPress: p.scroll().x, active: st().windows.c60.activeTabIds.default }));
          });
        }));`, 30000);
      record("revealStale", { ...r, scrolledBack: r.handScrolled !== undefined ? Math.abs(r.afterOtherWindowPress - r.handScrolled) > 2 : null });
    }

    if (want("profileDrag")) {
      const pd = await ctx.launch(ctx.app, { data: join(out, ".data", "profile-drag"), fresh: true, session: profileSession(port), onboarded: true, startTimeout: 120000 });
      try {
        const prun = (body, timeout = 60000) => pd.eval(`${ctx.HELPERS}\n${body}`, { timeout });
        await prun(`return wait(4500);`);
        const res = await prun(`const id = "pw";
          const pageA = () => globalThis.topStripPages && globalThis.topStripPages["pw|default"];
          const samples = [];
          return D.devSetWindowFrame(id, [60, 60, ${WIDTH}, ${HEIGHT}]).then((frame) => nativeOf(frame)).then((n) => {
            const loose = stripOrder(id); ac.actions.switchToTab(loose[5]);
            return wait(1200).then(() => {
              const start = 300, edge = 1130;
              const pts = [[start, 21], [start + 12, 21], [start + 80, 21], [edge - 40, 21], ...Array.from({ length: 40 }, () => [edge, 21])];
              ac.engine.call("windows.dev", { window: n, action: "drag:" + pts.map((p) => p.join(",")).join(";") });
              const sample = (label) => samples.push([label, Math.round(pageA() ? pageA().scroll().x : -1), st().windows[id].profileId]);
              return wait(1050).then(() => sample("before switch")).then(() => { ac.actions.switchProfile(id, "work"); }).then(() => wait(300)).then(() => sample("switched")).then(() => wait(1500)).then(() => sample("+1.8 s")).then(() => wait(1500)).then(() => sample("+3.3 s")).then(() => wait(4000)).then(() => sample("after release")).then(() => samples);
            });
          });`, 90000);
        const moved = res[3][1] - res[1][1];
        record("profileDrag", { samples: res, hiddenPageScrolledAfterSwitchPt: moved });
      } finally {
        await pd.quit().catch(() => {});
      }
    }
  } finally {
    await inst.quit().catch(() => {});
    server.close();
  }
}

export async function runTiming(ctx) {
  const out = ctx.out;
  mkdirSync(out, { recursive: true });
  const reps = Number(ctx.flag("reps", "6"));
  const server = await ctx.startServer();
  const port = server.address().port;
  const inst = await ctx.launch(ctx.app, { data: join(out, ".data", "timing"), fresh: true, session: ctx.familySession("timing", port), onboarded: true, startTimeout: 120000, files: { "perf-probe": "renders" } });
  const run = (body, timeout = 60000) => inst.eval(`${ctx.HELPERS}\n${body}`, { timeout });
  const results = { top: {}, control: {} };
  try {
    console.log(JSON.stringify(await run(`return wait(5000).then(() => [st().windows.c120.tabLayout, st().windows.k120.tabLayout]);`)));
    const timeAction = (id, action) =>
      run(`const P = globalThis.acPerf; const id = ${JSON.stringify(id)}; const loose = stripOrder(id).filter((t) => !st().tabs[t].pin);
        return D.devSetPointer(id, 640, 400, true).then(() => wait(300)).then(() => { P && P.reset(); const t0 = performance.now(); ${action}; return frames(2).then(() => { const ms = performance.now() - t0; const p = P ? P.read() : null; return { ms, commits: p ? p.commits : null, renders: p ? Object.values(p.renders).reduce((a, b) => a + b, 0) : null, commitMs: p ? p.commitMs : null, top: p ? Object.entries(p.renders).sort((a, b) => b[1] - a[1]).slice(0, 10) : null }; }); })
          .then((r) => wait(500).then(() => r));`);
    const actions = {
      switch: `ac.actions.switchToTab(loose[(loose.indexOf(st().windows[id].activeTabIds.default) + 37) % loose.length])`,
      open: `st().newTab(id, { url: "http://127.0.0.1:${port}/page/x/1" })`,
      close: `st().closeTab(st().windows[id].activeTabIds.default)`,
    };
    for (let i = 0; i < reps; i++)
      for (const [name, body] of Object.entries(actions)) {
        for (const [side, id] of [["top", "c120"], ["control", "k120"]]) {
          const r = await timeAction(id, body);
          (results[side][name] ??= []).push(r);
        }
      }
    const scrollSteps = [{ phase: "began", dx: -8 }, ...Array.from({ length: 30 }, () => ({ phase: "changed", dx: -20 })), { phase: "ended", dx: 0 }].map((s, i) => ({ ...s, timestampMs: i * 16 }));
    results.scroll = await run(`const w = st().windows.c120;
      return D.devSetWindowFrame("c120", [40 + Object.keys(st().windows).indexOf("c120") * 11, 60 + Object.keys(st().windows).indexOf("c120") * 7, w.frame[2], ${HEIGHT}]).then((frame) => nativeOf(frame)).then((n) => {
        const stamps = []; let on = true; const tick = (t) => { stamps.push(t); if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
        return globalThis.expo.modules.ArdiaSwipe.devSimulate(640, 21, n, ${JSON.stringify(scrollSteps)}, true).then(() => wait(600)).then(() => { on = false; const gaps = stamps.slice(1).map((t, i) => t - stamps[i]); return { frames: gaps.length, over25: gaps.filter((g) => g > 25).length, over50: gaps.filter((g) => g > 50).length, max: Math.round(Math.max(...gaps)) }; });
      });`);
    results.switchFrames = [];
    for (let i = 0; i < 6; i++)
      results.switchFrames.push(await run(`const id = "c120"; const loose = stripOrder(id);
        return D.devSetPointer(id, 640, 400, true).then(() => wait(400)).then(() => {
          const stamps = []; let on = true; const tick = (t) => { stamps.push(t); if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
          ac.actions.switchToTab(loose[(loose.indexOf(st().windows[id].activeTabIds.default) + 7) % loose.length]);
          return wait(600).then(() => { on = false; const gaps = stamps.slice(1).map((t, i) => t - stamps[i]); return { frames: gaps.length, over25: gaps.filter((g) => g > 25).length, over50: gaps.filter((g) => g > 50).length, max: Math.round(Math.max(...gaps)) }; });
        });`));
    const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const summary = {};
    for (const side of ["top", "control"])
      for (const [name, rs] of Object.entries(results[side]))
        summary[`${side}.${name}`] = { ms: +median(rs.map((r) => r.ms)).toFixed(1), commits: median(rs.map((r) => r.commits ?? 0)), renders: median(rs.map((r) => r.renders ?? 0)), commitMs: +median(rs.map((r) => r.commitMs ?? 0)).toFixed(1) };
    summary.scroll = results.scroll;
    summary.switchFrames = { over25: results.switchFrames.map((r) => r.over25), over50: results.switchFrames.map((r) => r.over50), max: results.switchFrames.map((r) => r.max) };
    summary.topRenders = { switch: results.top.switch?.at(-1)?.top, open: results.top.open?.at(-1)?.top, close: results.top.close?.at(-1)?.top };
    writeFileSync(join(out, "timing.json"), JSON.stringify({ summary, results }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
  } finally {
    await inst.quit().catch(() => {});
    server.close();
  }
}
