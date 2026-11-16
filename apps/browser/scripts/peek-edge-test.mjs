import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node peek-edge-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--keep-data]\n\nThe auto-hidden sidebar's peek, through the native edge watcher: a pointer resting on the window's bottom or top edge beside the peek keeps it out instead of flicking it shut and open, one that goes well past the edge closes it, an edge crossing outside the sidebar's column never opens it, once it slides away only the window's edge brings it back, pressing the other space's dot keeps it out, and with the window against a screen edge another display shares, the pointer stops at that edge to show the sidebar and a second push goes on through. Also (#1297, #1393, #1679): only the last 3 pt or past the edge open it, it stays out 40 pt past its edge and closes 200 ms after the pointer leaves, a drag on its edge resizes it instead of closing it, and Reveal hidden tabs on hover off leaves the edge alone.");
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
        .then(() => at(60, 66)).then(() => settle(200))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:down:60,66" })).then(() => settle(80))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:dragged:100,66" })).then(() => at(9 + 160 + 160, 66))
        .then(() => ac.engine.call("windows.dev", { window: win, action: "mouse:dragged:" + (9 + 160 + 160) + ",66" }))
        .then(() => settle(700)).then(() => { const held = live(); return ac.engine.call("windows.dev", { window: win, action: "mouse:up:" + (9 + 160 + 160) + ",66" }).then(() => settle(600)).then(() => ({ held, after: live() })); });`);
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

  await rep.check("with Reveal hidden tabs on hover off, the edge doesn't open it (#1393)", async () => {
    await run(`st().updateSettings({ revealTabsOnHover: false }); return settle(300);`);
    assert.equal(await run(`return peek();`), false);
    await run(`st().updateSettings({ revealTabsOnHover: true }); return away();`);
    assert.equal(await run(`return peek();`), true, "back on");
    assert.equal(await run(`return away();`), false);
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
  });

  await rep.check("with the window against the screen's edge, crossing to the next display stops at the edge and peeks; a second push goes through", async () => {
    const frame = (x) => `return globalThis.expo.modules.ArdiaDev.devSetWindowFrame("w1", [${x}, 100, ${WIDTH}, ${HEIGHT}]).then(() => settle(400));`;
    await run(frame(0));
    assert.equal(await run(`return at(300, 400).then(() => at(-30, 400)).then(() => settle(500)).then(live);`), true, "stopped at the screen edge, peeking");
    assert.equal(await run(`return at(-30, 400).then(() => settle(700)).then(live);`), false, "the second push went on to the next display");
    assert.equal(await run(`return at(300, 400).then(() => settle(500)).then(() => at(-30, 400)).then(() => settle(500)).then(live);`), true, "stops again on the next crossing");
    assert.equal(await run(`return away();`), false);
    const quick = await run(`const notes = []; const sub = globalThis.expo.modules.ArdiaAppWindows.addListener("onWindowEvent", (e) => e.screenEdge && notes.push(e.screenEdge));
      return at(300, 400).then(() => settle(500)).then(() => at(-30, 400)).then(() => settle(200)).then(() => at(-30, 400)).then(() => settle(300)).then(() => (sub.remove(), notes));`);
    assert.deepEqual(quick, ["stopped"], "a quick second push after the peek opened is the same stop, not a second one");
    assert.equal(await run(`return away();`), false);
    await run(frame(10));
    const notes = await run(`const notes = []; const sub = globalThis.expo.modules.ArdiaAppWindows.addListener("onWindowEvent", (e) => e.screenEdge && notes.push(e.screenEdge));
      return at(300, 400).then(() => settle(500)).then(() => at(-5, 400)).then(() => settle(100)).then(() => at(-30, 400)).then(() => settle(100)).then(() => at(-30, 400)).then(() => settle(300)).then(() => (sub.remove(), notes));`);
    assert.deepEqual(notes, ["stopped"], "one stop, counted even when the gap beside the window already opened the peek, and a quick second push is not a second stop");
    assert.equal(await run(`return away();`), false);
    await run(frame(200));
    assert.equal(await run(`return at(300, 400).then(() => at(-250, 400)).then(() => settle(500)).then(live);`), false, "a window away from the screen edge lets the pointer cross");
  });

  await rep.check("a stop at the screen edge ends when the window moves away from that edge", async () => {
    const frame = (x) => `return globalThis.expo.modules.ArdiaDev.devSetWindowFrame("w1", [${x}, 100, ${WIDTH}, ${HEIGHT}]).then(() => settle(400));`;
    await run(frame(0));
    assert.equal(await run(`return at(300, 400).then(() => at(-30, 400)).then(() => settle(500)).then(live);`), true, "stopped at the screen edge, peeking");
    await run(frame(300));
    assert.equal(await run(`return at(-300, 400).then(() => settle(700)).then(live);`), false, "the pointer left at the screen edge, 300 pt from the moved window");
    assert.equal(await run(`return at(-300, 200).then(() => settle(700)).then(live);`), false, "moving along the screen edge");
    await run(frame(200));
  });

  await rep.check("with the sidebar on the right and the window against the screen's right edge, crossing stops there too", async () => {
    const screenWidth = Number(execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSScreen.screens.objectAtIndex(0).frame.size.width']).toString());
    await run(`st().updateSettings({ sidebarSide: "right" }); return globalThis.expo.modules.ArdiaDev.devSetWindowFrame("w1", [${screenWidth - WIDTH}, 100, ${WIDTH}, ${HEIGHT}]).then(() => settle(600));`);
    try {
      assert.equal(await run(`return at(${WIDTH - 300}, 400).then(() => at(${WIDTH + 30}, 400)).then(() => settle(500)).then(live);`), true, "stopped at the right screen edge, peeking");
      assert.equal(await run(`return at(${WIDTH + 30}, 400).then(() => settle(700)).then(live);`), false, "the second push went on to the next display");
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
