import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node peek-edge-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--keep-data]\n\nThe auto-hidden sidebar's peek, through the native edge watcher: a pointer resting on the window's bottom or top edge beside the peek keeps it out instead of flicking it shut and open, one that goes well past the edge closes it, an edge crossing outside the sidebar's column never opens it, once it slides away only the window's edge brings it back, in a full-screen window the pointer resting at the screen's edge keeps it out, pressing the other space's dot keeps it out, and with the window against a screen edge another display shares, the pointer crosses without being held and coming straight back shows the sidebar. Also (#1297, #1393, #1679): only the last 3 pt or past the edge open it, it stays out 40 pt past its edge and closes 200 ms after the pointer leaves, a drag on its edge resizes it instead of closing it, and Reveal hidden tabs on hover off leaves the edge alone.");
  process.exit(2);
}
const appPath = resolve(appArg);
const port = args.find((a) => a.startsWith("--port="))?.slice(7);
const keep = args.includes("--keep-data");
const scratch = mkdtempSync(join(tmpdir(), "ac-peek-edge-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "peek-edge-test.log"), { name: "peek-edge-test" });

const WIDTH = 1280;
const HEIGHT = 800;
const fixture = session({
  profiles: ["Personal", "Work"],
  windows: [{ id: "w1", frame: [80, 80, WIDTH, HEIGHT], sidebarOpen: false }],
  tabs: [{ id: "a", url: "about:blank" }],
  settings: { sidebarWidth: 160, addressBar: "toolbar" },
});

let app = null;
const HELPERS = `
const st = () => ac.store.getState();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => !!globalThis.acLayout.peek.w1?.live;
const at = (x, y) => ac.shell.devSetPointer("w1", { x, y }).then(() => globalThis.expo.modules.ArdiaDev.devSidebarEdgePointer("w1", x, y, true));
const watchCalls = () => { const p = globalThis.acLayout.peek.w1; const calls = []; const show = p.show, hide = p.hide;
  p.show = (...a) => (calls.push("show"), show(...a)); p.hide = (...a) => (calls.push("hide"), hide(...a));
  return () => { p.show = show; p.hide = hide; return calls; }; };
const jitter = (x, ys, ms) => { const done = watchCalls(); let i = 0;
  return new Promise((r) => { const iv = setInterval(() => at(x, ys[i++ % ys.length]), ms); setTimeout(() => { clearInterval(iv); r(); }, ms * ys.length * 4); })
    .then(() => settle(400)).then(() => ({ calls: done(), live: live() })); };
const until = (test, ms) => { const end = Date.now() + ms; const poll = () => (test() ? Promise.resolve(true) : Date.now() > end ? Promise.resolve(false) : settle(50).then(poll)); return poll(); };
const ROW_Y = 94;
const peek = () => at(-4, 400).then(() => settle(500)).then(() => at(80, 400)).then(() => settle(300)).then(live);
const away = () => at(700, 400).then(() => settle(700)).then(live);
`;
const run = (body) => app.eval(`${HELPERS}\n${body}`);

try {
  app = await launch(appPath, { data, port, session: fixture, onboarded: true });
  await run(`if (!st().settings.autoHideTabs) st().toggleSidebar("w1"); st().updateSettings({ sidebarWidth: 160, addressBar: "toolbar" }); return settle(900);`);

  await rep.check("the left edge opens the peek and the page closes it", async () => {
    assert.equal(await run(`return peek();`), true, "opens from the left edge");
    assert.equal(await run(`return away();`), false, "closes over the page");
  });

  await rep.check("once it starts sliding away, only the window's edge brings it back, not the column it is leaving (#1192)", async () => {
    assert.equal(await run(`return peek();`), true);
    const back = await run(`return at(700, 400).then(() => settle(260)).then(() => at(80, 400)).then(() => settle(700)).then(live);`);
    assert.equal(back, false, "back into the old column mid-slide");
    assert.equal(await run(`return peek();`), true);
    const edge = await run(`return at(700, 400).then(() => settle(260)).then(() => at(2, 400)).then(() => settle(700)).then(live);`);
    assert.equal(edge, true, "the edge mid-slide");
    assert.equal(await run(`return away();`), false);
  });

  await rep.check("only the window's edge opens it: 5 pt in doesn't, 2 pt in and past the edge do (#1297)", async () => {
    assert.equal(await run(`return at(300, 400).then(() => settle(300)).then(() => at(5, 400)).then(() => settle(500)).then(live);`), false, "5 pt in");
    assert.equal(await run(`return at(2, 400).then(() => settle(500)).then(live);`), true, "2 pt in");
    assert.equal(await run(`return away();`), false);
  });

  await rep.check("it stays out 30 pt past its edge, closes past 40 pt, and a quick overshoot within 200 ms doesn't close it (#1297)", async () => {
    assert.equal(await run(`return peek();`), true);
    assert.equal(await run(`return at(9 + 160 + 30, 400).then(() => settle(600)).then(live);`), true, "30 pt past the panel");
    assert.equal(await run(`return at(9 + 160 + 80, 400).then(() => settle(120)).then(() => at(120, 400)).then(() => settle(600)).then(live);`), true, "out and back within 120 ms");
    assert.equal(await run(`return at(9 + 160 + 45, 400).then(() => settle(600)).then(live);`), false, "45 pt past the panel");
  });

  await rep.check("a drag that starts on the peek's edge resizes it and keeps it out, even with the pointer ahead of the panel (#1679)", async () => {
    assert.equal(await run(`return peek();`), true);
    const out = await run(`const dev = globalThis.expo.modules.ArdiaDev; let win;
      return ac.engine.call("windows.list", {}).then((l) => { win = l.find((x) => x.hasRoot).window; })
        .then(() => at(9 + 160 - 2, 400)).then(() => settle(200))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:down:" + (9 + 160 - 2) + ",400" })).then(() => settle(100))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:dragged:" + (9 + 160 + 120) + ",400" })).then(() => at(9 + 160 + 400, 400))
        .then(() => settle(600)).then(() => { const held = live(); return ac.engine.call("windows.dev", { window: win, action: "mouse:up:" + (9 + 160 + 120) + ",400" }).then(() => settle(300)).then(() => ({ held, width: st().settings.sidebarWidth })); });`);
    assert.equal(out.held, true, "out while the button is down, the pointer 280 pt ahead of the panel's edge");
    assert.ok(out.width > 160, `resized to ${out.width}`);
    await run(`st().updateSettings({ sidebarWidth: 160 }); return away();`);
  });

  await rep.check("a drag that starts on a tab row keeps the peek out while the button is down, the pointer 160 pt past its edge (#1679)", async () => {
    assert.equal(await run(`return peek();`), true);
    const out = await run(`let win;
      return ac.engine.call("windows.list", {}).then((l) => { win = l.find((w) => w.hasRoot).window; })
        .then(() => at(60, ROW_Y)).then(() => settle(200))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:down:60," + ROW_Y })).then(() => settle(80))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:dragged:100," + ROW_Y })).then(() => settle(80))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:dragged:140," + ROW_Y }))
        .then(() => until(() => globalThis.acTabDrag.getState().phase === "tab", 1500)).then((dragging) => at(9 + 160 + 160, ROW_Y).then(() => dragging))
        .then((dragging) => ac.engine.call("windows.dev", { window: win, action: "mouse:dragged:" + (9 + 160 + 160) + "," + ROW_Y }).then(() => dragging))
        .then((dragging) => settle(700).then(() => { const held = live(); return ac.engine.call("windows.dev", { window: win, action: "mouse:up:" + (9 + 160 + 160) + "," + ROW_Y }).then(() => settle(600)).then(() => ({ dragging, held, after: live() })); }));`);
    assert.equal(out.dragging, true, "the press on the first tab row became a tab drag");
    assert.equal(out.held, true, "out while the button is down");
    assert.equal(out.after, false, "closes once the button comes up away from it");
    await run(`return away();`);
  });

  for (const [where, x, y] of [["the empty list", 80, 420], ["the header", 120, 20]]) {
    await rep.check(`a press on ${where} is a window drag: the peek stays out while the button is down (#1679)`, async () => {
      assert.equal(await run(`return peek();`), true);
      const out = await run(`let win;
        return ac.engine.call("windows.list", {}).then((l) => { win = l.find((w) => w.hasRoot).window; })
          .then(() => at(${x}, ${y})).then(() => settle(200))
          .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:down:${x},${y}" }))
          .then((hit) => settle(700).then(() => ({ hit, held: live() })))
          .then((r) => ac.engine.call("windows.dev", { window: win, action: "mouse:up:${x},${y}" }).then(() => settle(300)).then(() => ({ ...r, after: live() })));`);
      assert.match(out.hit, /WindowDragRegion/, "the press lands on a window drag region");
      assert.equal(out.held, true, "out while the button is down");
      assert.equal(out.after, true, "still out with the pointer over it after the button comes up");
      await run(`return away();`);
    });
  }

  await rep.check("in a full-screen window, a pointer resting on the left edge keeps the peek out, and moving onto it keeps it too", async () => {
    const fullScreen = (on) => `return ac.engine.call("windows.list", {}).then((l) => ac.engine.call("windows.dev", { window: l.find((w) => w.hasRoot).window, action: "fakeFullScreen:${on ? 1 : 0}" })).then(() => settle(900));`;
    await run(fullScreen(true));
    try {
      const rest = await run(`return at(300, 400).then(() => settle(400)).then(() => { const done = watchCalls(); return at(0, 400).then(() => settle(1500)).then(() => ({ calls: done(), live: live() })); });`);
      assert.deepEqual(rest.calls.filter((c) => c === "hide"), [], `no hide with the pointer at the edge: ${rest.calls}`);
      assert.equal(rest.live, true, "out with the pointer resting at the screen's edge");
      assert.equal(await run(`return at(80, 400).then(() => settle(700)).then(live);`), true, "out with the pointer over it");
      assert.equal(await run(`return away();`), false, "closes over the page");
    } finally {
      await run(fullScreen(false));
    }
  });

  await rep.check("a pointer resting on the bottom edge beside the peek keeps it out", async () => {
    assert.equal(await run(`return peek();`), true);
    const out = await run(`return jitter(80, [${HEIGHT - 3}, ${HEIGHT + 3}, ${HEIGHT - 1}, ${HEIGHT + 6}], 160);`);
    assert.deepEqual(out.calls.filter((c) => c === "hide"), [], `no hide: ${out.calls}`);
    assert.equal(out.live, true);
  });

  await rep.check("the bottom-left corner, just past both edges, keeps it out", async () => {
    const out = await run(`return jitter(-3, [${HEIGHT + 4}, ${HEIGHT - 4}], 160);`);
    assert.deepEqual(out.calls.filter((c) => c === "hide"), [], `no hide: ${out.calls}`);
    assert.equal(out.live, true);
  });

  await rep.check("the top edge keeps it out the same way", async () => {
    const out = await run(`return at(80, 300).then(() => settle(200)).then(() => jitter(80, [2, -4], 160));`);
    assert.deepEqual(out.calls.filter((c) => c === "hide"), [], `no hide: ${out.calls}`);
    assert.equal(out.live, true);
  });

  await rep.check("going well past the bottom edge closes it, and coming back in below the left edge strip doesn't reopen it", async () => {
    assert.equal(await run(`return at(80, ${HEIGHT + 40}).then(() => settle(700)).then(live);`), false, "closed 40 pt below the window");
    assert.equal(await run(`return at(80, ${HEIGHT + 3}).then(() => settle(500)).then(live);`), false, "just below the window, beside the closed sidebar");
    assert.equal(await run(`return at(80, ${HEIGHT - 3}).then(() => settle(500)).then(live);`), false, "inside the window, past the edge strip");
  });

  await rep.check("a closed sidebar doesn't open from just below the window's bottom-left corner", async () => {
    assert.equal(await run(`return at(-3, ${HEIGHT + 4}).then(() => settle(500)).then(live);`), false);
    assert.equal(await run(`return away();`), false);
  });

  await rep.check("pressing the other space's dot switches spaces and keeps the peek out", async () => {
    assert.equal(await run(`return peek();`), true);
    const out = await run(`const before = st().windows.w1.profileId; const other = st().profileOrder.find((p) => p !== before); const done = watchCalls();
      return at(91, ${HEIGHT - 31}).then(() => ac.actions.switchProfile("w1", other, true)).then(() => settle(1200)).then(() => ({ switched: st().windows.w1.profileId === other, calls: done(), live: live() }));`);
    assert.equal(out.switched, true);
    assert.deepEqual(out.calls.filter((c) => c === "hide"), [], `no hide: ${out.calls}`);
    assert.equal(out.live, true);
    await run(`ac.actions.switchProfile("w1", st().profileOrder[0], true); return settle(900).then(() => away());`);
  });

  await rep.check("with the window against a screen edge another display shares, the pointer is never held there: it crosses, and coming straight back peeks", async () => {
    const frame = (x) => `return globalThis.expo.modules.ArdiaDev.devSetWindowFrame("w1", [${x}, 100, ${WIDTH}, ${HEIGHT}]).then(() => settle(400));`;
    const listen = `const notes = []; const sub = globalThis.expo.modules.ArdiaAppWindows.addListener("onWindowEvent", (e) => e.screenEdge && notes.push(e.screenEdge));`;
    await run(frame(0));
    const crossed = await run(`${listen}
      return at(300, 400).then(() => settle(120)).then(() => at(-30, 400)).then(() => settle(500)).then(() => { sub.remove(); return { notes, live: live() }; });`);
    assert.deepEqual(crossed.notes, ["crossed"], "the crossing goes on to the next display");
    assert.equal(crossed.live, false, "and leaves the sidebar hidden");
    const back = await run(`${listen}
      return at(300, 400).then(() => settle(120)).then(() => at(-30, 400)).then(() => settle(150)).then(() => at(4, 400)).then(() => settle(500)).then(() => { sub.remove(); return { notes, live: live() }; });`);
    assert.deepEqual(back.notes, ["crossed", "returned"], "an overshoot that comes straight back");
    assert.equal(back.live, true, "peeks");
    assert.equal(await run(`return at(80, 400).then(() => settle(500)).then(live);`), true, "and stays out with the pointer over it");
    assert.equal(await run(`return at(-30, 400).then(() => settle(60)).then(() => !!globalThis.acLayout.peek.w1?.leaving);`), true, "crossing to the next display starts closing it at once, not after the 200 ms grace");
    assert.equal(await run(`return at(4, 400).then(() => settle(500)).then(live);`), true, "coming straight back while it closes opens it again");
    assert.equal(await run(`return at(-30, 400).then(() => settle(700)).then(live);`), false, "and crossing again closes it");
    assert.equal(await run(`return away();`), false);
    assert.equal(await run(`return at(300, 400).then(() => settle(120)).then(() => at(-30, 400)).then(() => settle(150)).then(() => at(50, 400)).then(() => settle(500)).then(() => { st().toggleSidebar("w1"); return settle(600); }).then(() => { st().toggleSidebar("w1"); return settle(900); }).then(() => at(1, 400)).then(() => settle(500)).then(live);`), true, "after the edge watch stops and starts again, the edge strip still opens it");
    assert.equal(await run(`return away();`), false);
    assert.equal(await run(`return at(300, 400).then(() => settle(500)).then(() => { st().toggleSidebar("w1"); return settle(600); }).then(() => at(-30, 400)).then(() => settle(300)).then(() => { st().toggleSidebar("w1"); return settle(250); }).then(() => at(50, 400)).then(() => settle(500)).then(live);`), false, "a pointer already past the edge when the watch starts again has made no crossing, so coming back in doesn't peek");
    assert.equal(await run(`return away();`), false);
    await run(frame(200));
    assert.equal(await run(`return at(300, 400).then(() => at(-250, 400)).then(() => settle(500)).then(live);`), false, "a window away from the screen edge lets the pointer cross");
  });

  await rep.check("a peek opened at the screen edge closes once the window moves away from that edge", async () => {
    const frame = (x) => `return globalThis.expo.modules.ArdiaDev.devSetWindowFrame("w1", [${x}, 100, ${WIDTH}, ${HEIGHT}]).then(() => settle(400));`;
    await run(frame(0));
    assert.equal(await run(`return at(300, 400).then(() => settle(120)).then(() => at(-30, 400)).then(() => settle(150)).then(() => at(4, 400)).then(() => settle(500)).then(live);`), true, "came back, peeking");
    await run(frame(300));
    assert.equal(await run(`return at(-300, 400).then(() => settle(700)).then(live);`), false, "the pointer left at the screen edge, 300 pt from the moved window");
    await run(frame(200));
  });

  await rep.check("with the sidebar on the right and the window against the screen's right edge, the same holds there", async () => {
    const screenWidth = Number(execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSScreen.screens.objectAtIndex(0).frame.size.width']).toString());
    await run(`st().updateSettings({ sidebarSide: "right" }); return globalThis.expo.modules.ArdiaDev.devSetWindowFrame("w1", [${screenWidth - WIDTH}, 100, ${WIDTH}, ${HEIGHT}]).then(() => settle(600));`);
    try {
      assert.deepEqual(await run(`const notes = []; const sub = globalThis.expo.modules.ArdiaAppWindows.addListener("onWindowEvent", (e) => e.screenEdge && notes.push(e.screenEdge));
        return at(${WIDTH - 300}, 400).then(() => settle(120)).then(() => at(${WIDTH - 0.5}, 400)).then(() => settle(200)).then(() => { sub.remove(); return notes; });`), [], "half a point inside the right edge is still this display");
      assert.equal(await run(`return at(${WIDTH - 300}, 400).then(() => settle(120)).then(() => at(${WIDTH + 30}, 400)).then(() => settle(500)).then(live);`), false, "crossed the right screen edge without peeking");
      assert.equal(await run(`return at(${WIDTH - 300}, 400).then(() => settle(120)).then(() => at(${WIDTH + 30}, 400)).then(() => settle(150)).then(() => at(${WIDTH - 4}, 400)).then(() => settle(500)).then(live);`), true, "coming straight back peeks");
    } finally {
      await run(`st().updateSettings({ sidebarSide: "left" }); return settle(400);`);
    }
  });
} finally {
  await run(`return globalThis.expo.modules.ArdiaDev.devSidebarEdgePointer("w1", 0, 0, false).then(() => ac.shell.devSetPointer("w1", null));`).catch(() => {});
  await app?.quit();
  if (!keep) rmSync(data, { recursive: true, force: true });
  else rep.say(`data: ${data}`);
}
process.exit(rep.summary() ? 0 : 1);
