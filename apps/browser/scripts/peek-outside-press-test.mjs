import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error(`usage: node peek-outside-press-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--js=<pinned|live|none>] [--out=<dir>] [--keep-data]

A Peek closes on a click outside its card, through AppKit's event path (#4576): on the sidebar's empty space, on the
shown tab's own row, on the gutter between the sidebar and the page, on the top tab strip's empty space and on the dim,
while a click on another tab's row switches to it and keeps the Peek with its tab, and a right-click or a drag of a row
leaves it open. --out writes window snapshots before and after each click and results.json there.`);
  process.exit(2);
}
const appPath = resolve(appArg);
const port = args.find((a) => a.startsWith("--port="))?.slice(7);
const js = args.find((a) => a.startsWith("--js="))?.slice(5);
const out = args.find((a) => a.startsWith("--out="))?.slice(6);
const keep = args.includes("--keep-data");
const scratch = mkdtempSync(join(tmpdir(), "ac-peek-outside-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "peek-outside-press-test.log"), { name: "peek-outside-press-test" });
if (out) mkdirSync(resolve(out), { recursive: true });

const server = createServer((req, res) => {
  const name = req.url.slice(1).split("?")[0] || "root";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${name.toUpperCase()}</title><link rel="icon" href="data:,"><body style="font:40px sans-serif;margin:40px">${name}</body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = (name) => `http://127.0.0.1:${server.address().port}/${name}`;
const tab = (id) => ({ id, url: url(id), title: id.toUpperCase() });
const SIDEBAR = 220;
const fixture = session({
  windows: [{ id: "w1", frame: [80, 80, 1280, 800], activeTabIds: { default: "a" } }],
  tabs: [tab("a"), tab("b"), tab("c")],
  settings: { sidebarWidth: SIDEBAR, addressBar: "toolbar" },
});

let app = null;
const HELPERS = `
const st = () => ac.store.getState();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const win = () => ac.engine.call("windows.list").then((ws) => ws.find((w) => w.hasRoot).window);
const act = (a) => win().then((n) => ac.engine.call("windows.dev", { window: n, action: a }));
const shown = () => st().windows.w1.activeTabIds[st().windows.w1.profileId];
const peekOf = (id) => st().peeks[id]?.tabId ?? null;
const center = (id) => new Promise((r) => {
  const item = [...globalThis.sidebarDrag.items.values()].find((i) => i.view && i.kind === "row" && i.tabIds.includes(id));
  item ? item.view.measureInWindow((x, y, w, h) => r([Math.round(x + Math.min(w / 2, 60)), Math.round(y + h / 2)])) : r(null);
});
const point = (x, y) => ac.shell.devSetPointer("w1", { x, y });
const firstHit = (points, wanted) => {
  const missed = {};
  return points.reduce((found, [x, y]) => found.then((hit) => hit ?? act("hit:" + x + "," + y).then((chain) => {
    if (wanted(chain)) return { x, y, chain };
    (missed[chain] ??= []).push([x, y]);
    return null;
  })), Promise.resolve(null)).then((hit) => hit ?? { missed: Object.fromEntries(Object.entries(missed).map(([chain, at]) => [chain, [at[0], at.at(-1), at.length]])) });
};
const dragRegion = (chain) => chain.split(" < ")[0].includes("WindowDragRegion");
const peekOpen = (from = "a") => {
  if (st().peeks[from]) st().closePeek(from);
  st().activate(from);
  return settle(400).then(() => st().openPeek(from, ${JSON.stringify(url("peek"))} + "?n=" + Date.now(), { x: 700, y: 300 })).then(() => settle(1600)).then(() => peekOf(from));
};
const click = (x, y, kind = "") => point(x, y).then(() => act("mouse:" + kind + "down:" + x + "," + y)).then((hit) => settle(70).then(() => act("mouse:" + kind + "up:" + x + "," + y)).then(() => hit));
const snap = (path) => (path ? ac.shell.devSnapshotWindow("w1", path).catch(() => false) : Promise.resolve(null));
const afterClick = (x, y, kind, from, shots) => snap(shots?.[0]).then(() => click(x, y, kind)).then((hit) => settle(1200).then(() => snap(shots?.[1])).then(() => ({ hit, peek: peekOf(from), shown: shown() })));
`;
const run = (body, timeout = 30000) => app.eval(`${HELPERS}\n${body}`, { timeout });
const shots = (name) => (out ? [join(resolve(out), `${name}-before.png`), join(resolve(out), `${name}-after.png`)] : null);
const results = {};

async function clickOutside(name, findPoint, { kind = "", from = "a" } = {}) {
  const opened = await run(`return peekOpen(${JSON.stringify(from)});`);
  assert.ok(opened, "a Peek opened");
  const at = await run(`return ${findPoint};`);
  if (!at || at.missed) results[name] = { opened, missed: at?.missed ?? null };
  assert.ok(at && !at.missed, `found where to click for ${name}: ${JSON.stringify(at?.missed ?? null)}`);
  const r = await run(`return afterClick(${at.x}, ${at.y}, ${JSON.stringify(kind)}, ${JSON.stringify(from)}, ${JSON.stringify(shots(name))});`);
  results[name] = { at, opened, ...r };
  rep.log(name, results[name]);
  return { opened, ...r };
}

const emptySidebar = `firstHit(Array.from({ length: 40 }, (_, i) => [110, 760 - i * 10]), dragRegion)`;
const gutter = `firstHit(Array.from({ length: 30 }, (_, i) => [${SIDEBAR} - 20 + i, 420]), dragRegion)`;
const emptyStrip = `firstHit([8, 21, 34].flatMap((y) => Array.from({ length: 120 }, (_, i) => [1270 - i * 10, y])), dragRegion)`;

try {
  app = await launch(appPath, { data, port, session: fixture, onboarded: true, ...(js ? { js } : {}) });
  await run("return settle(1200);");

  await rep.check("a click on the sidebar's empty space closes the Peek", async () => {
    const r = await clickOutside("sidebar-empty", emptySidebar);
    assert.equal(r.peek, null, "the Peek is still open");
    assert.equal(r.shown, "a");
  });

  await rep.check("a click on the shown tab's own row closes the Peek", async () => {
    const r = await clickOutside("own-row", `center("a").then((p) => p && { x: p[0], y: p[1], chain: "row a" })`);
    assert.equal(r.peek, null, "the Peek is still open");
    assert.equal(r.shown, "a");
  });

  await rep.check("a click on another tab's row switches to it and keeps the Peek with its tab, shown again on the way back", async () => {
    const r = await clickOutside("other-row", `center("b").then((p) => p && { x: p[0], y: p[1], chain: "row b" })`);
    assert.equal(r.shown, "b", "the click switched tabs");
    assert.equal(r.peek, r.opened, "the Peek stayed with tab a");
    const back = await run(`st().activate("a"); return settle(900).then(() => ({ shown: shown(), peek: peekOf("a") }));`);
    assert.deepEqual(back, { shown: "a", peek: r.opened }, "the same Peek shows again on tab a");
  });

  await rep.check("a click on the gutter between the sidebar and the page closes the Peek", async () => {
    const r = await clickOutside("gutter", gutter);
    assert.equal(r.peek, null, "the Peek is still open");
  });

  await rep.check("a right-click on the sidebar's empty space leaves the Peek open", async () => {
    const r = await clickOutside("sidebar-right-click", emptySidebar, { kind: "right" });
    assert.equal(r.peek, r.opened);
  });

  await rep.check("a drag of the shown tab's row leaves the Peek open", async () => {
    const opened = await run(`return peekOpen("a");`);
    const r = await run(`return center("a").then(([x, y]) => act("drag:" + x + "," + y + ";" + x + "," + (y + 60))).then(() => settle(1500)).then(() => ({ peek: peekOf("a") }));`);
    results["row-drag"] = { opened, ...r };
    rep.log("row-drag", results["row-drag"]);
    assert.equal(r.peek, opened);
  });

  await rep.check("a click on the dim over the page still closes the Peek", async () => {
    const r = await clickOutside("dim", `Promise.resolve({ x: ${SIDEBAR} + 30, y: 420, chain: "dim" })`);
    assert.equal(r.peek, null);
  });

  await rep.check("with tabs on top, a click on the strip's empty space closes the Peek", async () => {
    await run(`st().toggleTabLayout("w1"); return settle(1500);`);
    const r = await clickOutside("strip-empty", emptyStrip);
    assert.equal(r.peek, null, "the Peek is still open");
  });
} finally {
  if (out) writeFileSync(join(resolve(out), "results.json"), JSON.stringify({ results, checks: rep.results }, null, 1));
  await app?.quit();
  server.close();
  if (!keep) rmSync(data, { recursive: true, force: true });
  else rep.say(`data: ${data}`);
}
process.exit(rep.summary() ? 0 : 1);
