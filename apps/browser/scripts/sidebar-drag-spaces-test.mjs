import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node sidebar-drag-spaces-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--bundle-port=<Metro port>] [--keep-data]\n\nA tab held in the sidebar stays held while the sidebar turns to another profile, and drops into that profile: through the first swipe to a profile not shown yet (its first use opens the content blocker's hidden window, whose window event used to end the press once scroll events had reached AppKit), through a scroll of the list followed by a first visit, through a scroll that was already under way when the tab was pressed, and through a swipe back to a profile already shown. Scroll events go through the app's own event monitor, as a trackpad's do: while a tab is held none is handed on to AppKit, and with nothing held all of a list scroll is. Presses, drags and scroll events are posted to the hidden instance's own window; nothing touches the real pointer.");
  process.exit(2);
}
const appPath = resolve(appArg);
const port = args.find((a) => a.startsWith("--port="))?.slice(7);
const bundlePort = args.find((a) => a.startsWith("--bundle-port="))?.slice(14);
const keep = args.includes("--keep-data");
const scratch = mkdtempSync(join(tmpdir(), "ac-sidebar-drag-spaces-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "sidebar-drag-spaces-test.log"), { name: "sidebar-drag-spaces-test" });

const server = createServer((req, res) => {
  const name = req.url.slice(1) || "root";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${name.toUpperCase()}</title><link rel="icon" href="data:,"><body style="font:40px sans-serif">${name}</body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = (name) => `http://127.0.0.1:${server.address().port}/${name}`;
const tab = (id, profileId) => ({ id, url: url(id), title: id.toUpperCase(), ...(profileId ? { profileId } : {}) });
const fixture = session({
  profiles: ["Personal", "Work", "Lab", "Notes"],
  windows: [{ id: "w1", frame: [80, 80, 1280, 800], activeTabIds: { default: "p0", work: "w0", lab: "l0", notes: "n0" } }],
  tabs: [...["p0", "p1", "p2", "p3"].map((id) => tab(id)), ...["w0", "w1", "w2", "w3"].map((id) => tab(id, "work")), ...["l0", "l1", "l2"].map((id) => tab(id, "lab")), ...["n0", "n1"].map((id) => tab(id, "notes"))],
});

let app = null;
const HELPERS = `
const st = () => ac.store.getState();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const win = () => ac.engine.call("windows.list").then((ws) => ws.find((w) => w.hasRoot).window);
const act = (a) => win().then((n) => ac.engine.call("windows.dev", { window: n, action: a }));
const drag = () => globalThis.sidebarDrag;
const frame = (view) => new Promise((r) => (view ? view.measureInWindow((x, y, w, h) => r({ x, y, w, h })) : r(null)));
const itemOf = (id) => [...drag().items.values()].find((i) => i.view && i.kind !== "tail" && i.tabIds.includes(id));
const frameOf = (id) => frame(itemOf(id) && itemOf(id).view);
const tabsOf = (profile) => st().windows.w1.tabIds.filter((id) => st().tabs[id].profileId === profile);
const state = () => ({ shown: st().windows.w1.profileId, active: st().windows.w1.activeTabIds, held: drag().active, drop: drag().session ? drag().session.drop : null,
  default: tabsOf("default"), work: tabsOf("work"), lab: tabsOf("lab"), notes: tabsOf("notes") });
`;
const run = (body) => app.eval(`${HELPERS}\n${body}`, { timeout: 30000 });

const scrollSteps = (deltas) => deltas.map(([phase, dx, dy, atMs], i) => ({ phase, dx, dy, atMs: atMs ?? i * 16, timestampMs: atMs ?? i * 16, dispatch: "app" }));
const swipeTo = (sign) => scrollSteps([["began", 0, 0], ["changed", 18 * sign, 1], ["changed", 22 * sign, 0], ["changed", 22 * sign, 0], ["ended", 0, 0]]);
const listScroll = scrollSteps([["began", 0, 0], ["changed", 0, 6], ["changed", 0, 6], ["ended", 0, 0]]);
const slowListScroll = scrollSteps([["began", 0, 0, 0], ["changed", 0, 6, 16], ["changed", 0, 6, 2600], ["ended", 0, 0, 2616]]);
const simulate = (steps) => `globalThis.acSwipe.sidebar("w1").devSimulate(${JSON.stringify(steps)}, { ignorePreference: true })`;
const handedOn = (result) => result.events.map((e) => !e.monitorSwallowed);

async function hold(id) {
  const row = await run(`return frameOf(${JSON.stringify(id)});`);
  assert.ok(row, `${id} has a row in the page on screen`);
  const x = Math.round(row.x + 40), y = Math.round(row.y + row.h / 2);
  await run(`return ac.shell.devSetPointer("w1", { x: ${x}, y: ${y} }).then(() => act("mouse:down:${x},${y}")).then(() => settle(120));`);
  for (const dy of [3, 8, 14, 22, 30]) await run(`return act("mouse:dragged:${x + 4},${y + dy}").then(() => settle(40));`);
  assert.equal((await run(`return state();`)).held, true, `${id} is held after a 30 pt drag`);
  return { x: x + 6, y: y + 30 };
}

async function carryOnto(at, target) {
  const row = await run(`return frameOf(${JSON.stringify(target)});`);
  assert.ok(row, `${target} has a row in the page on screen`);
  const y = Math.round(row.y + 3);
  for (const k of [0.3, 0.6, 1]) await run(`return act("mouse:dragged:${at.x},${Math.round(at.y + (y - at.y) * k)}").then(() => settle(60));`);
  const over = await run(`return state();`);
  await run(`return act("mouse:up:${at.x},${y}").then(() => settle(1200));`);
  return over;
}

try {
  app = await launch(appPath, { data, port, session: fixture, onboarded: true, ...(bundlePort ? { metroPort: Number(bundlePort) } : {}) });
  rep.log(`instance: pid ${app.pid}, DevTools port ${app.port}, data ${data}`);
  await sleep(1500);
  await run(`return act("fakeActiveClicks");`);
  await run(`st().updateSettings({ warnBeforeMovingTabsToProfile: false }); return settle(600);`);

  await rep.check("a tab held through the first swipe to a profile not shown yet stays held, and lands among that profile's tabs", async () => {
    const at = await hold("p2");
    const swiped = await run(`return ${simulate(swipeTo(-1))}.then(() => settle(1000)).then(() => state());`);
    assert.equal(swiped.shown, "work", "the sidebar turned to Work");
    assert.equal(swiped.held, true, "the tab is still held after the swipe");
    const over = await carryOnto(at, "w2");
    assert.deepEqual(over.drop, { type: "tabs", placement: { pinned: false, beforeId: "w2" }, sequence: [] }, "the drag targets Work's rows");
    const after = await run(`return state();`);
    assert.deepEqual(after.work, ["w0", "w1", "p2", "w2", "w3"]);
    assert.deepEqual(after.default, ["p0", "p1", "p3"]);
    assert.equal(after.shown, "work");
    assert.equal(after.active.work, "p2", "the dropped tab is the one shown");
    assert.equal(after.held, false);
    return "p2 moved to Work before w2";
  });

  await rep.check("the sidebar takes a click right after", async () => {
    const row = await run(`return frameOf("w3");`);
    const x = Math.round(row.x + 40), y = Math.round(row.y + row.h / 2);
    await run(`return ac.shell.devSetPointer("w1", { x: ${x}, y: ${y} }).then(() => act("mouse:down:${x},${y}")).then(() => settle(70)).then(() => act("mouse:up:${x},${y}")).then(() => settle(800));`);
    assert.equal((await run(`return state();`)).active.work, "w3");
  });

  await rep.check("a tab held while the list is scrolled and a third profile is shown for the first time stays held, and lands there", async () => {
    const at = await hold("w1");
    const turned = await run(`return ${simulate(listScroll)}.then((scrolled) => { st().switchProfile("w1", "lab"); return settle(1000).then(() => ({ ...state(), scrolled })); });`);
    assert.deepEqual(handedOn(turned.scrolled), [false, false, false, false], "none of the scroll reached AppKit while the tab was held");
    assert.equal(turned.shown, "lab");
    assert.equal(turned.held, true, "the tab is still held after the scroll and the turn");
    await carryOnto(at, "l1");
    const after = await run(`return state();`);
    assert.deepEqual(after.lab, ["l0", "w1", "l1", "l2"]);
    assert.equal(after.active.lab, "w1");
    return "w1 moved to Lab before l1";
  });

  await rep.check("a scroll under way before the tab was pressed is kept from AppKit from the press on, and the tab stays held through a first visit", async () => {
    await run(`globalThis.slowScroll = ${simulate(slowListScroll)}; return true;`);
    const at = await hold("l0");
    const scrolled = await run(`return globalThis.slowScroll;`);
    assert.deepEqual(handedOn(scrolled), [true, true, false, false], "the scroll's start went to AppKit, and nothing after the press");
    const turned = await run(`st().switchProfile("w1", "notes"); return settle(1000).then(() => state());`);
    assert.equal(turned.held, true, "the tab is still held after the first show of Notes");
    await carryOnto(at, "n1");
    assert.deepEqual((await run(`return state();`)).notes, ["n0", "l0", "n1"]);
    await run(`st().switchProfile("w1", "lab"); return settle(1000);`);
    return "l0 moved to Notes before n1";
  });

  await rep.check("with nothing held, a list scroll is handed on to AppKit whole", async () => {
    const scrolled = await run(`return ${simulate(listScroll)};`);
    assert.deepEqual(handedOn(scrolled), [true, true, true, true]);
  });

  await rep.check("a tab held through a swipe back to a profile already shown lands there too", async () => {
    const at = await hold("l2");
    const swiped = await run(`return ${simulate(swipeTo(1))}.then(() => settle(1000)).then(() => state());`);
    assert.equal(swiped.shown, "work");
    assert.equal(swiped.held, true);
    await carryOnto(at, "w2");
    const after = await run(`return state();`);
    assert.deepEqual(after.work, ["w0", "p2", "l2", "w2", "w3"]);
    assert.deepEqual(after.lab, ["w1", "l1"]);
    return "l2 moved to Work before w2";
  });
  await run(`return ac.shell.devSetPointer("w1", null);`);
} finally {
  await app?.quit();
  server.close();
  if (!keep) rmSync(data, { recursive: true, force: true });
  else rep.say(`data: ${data}`);
}
process.exit(rep.summary() ? 0 : 1);
