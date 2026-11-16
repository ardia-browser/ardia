import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node sidebar-slide-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--trials=<n>] [--keep-data]\n\nClosing a sidebar tab leaves no blank space: the rows below slide up and every slide rests at 0, the offset a row is drawn with the next time it renders. Also when the list updates while the slides are still running later than they should have finished, as after a close that kept the app busy (a row-sized gap stayed under the closed tab, and rows drew over each other).");
  process.exit(2);
}
const appPath = resolve(appArg);
const port = args.find((a) => a.startsWith("--port="))?.slice(7);
const trials = Number(args.find((a) => a.startsWith("--trials="))?.slice(9) ?? 4);
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
const fixture = session({
  windows: [{ id: "w1", frame: [80, 80, 1280, 800], activeTabIds: { default: "t0" } }],
  tabs: Array.from({ length: ROWS }, (_, i) => ({ id: `t${i}`, url: url(`t${i}`), title: `T${i}` })),
});

let app = null;
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
const showEach = () => open().reduce((p, id) => p.then(() => { st().activate(id); return settle(80); }), Promise.resolve());
const rest = () => slides().filter((s) => s.value.__getValue() !== 0 || !s.landed).map((s) => ({ offset: s.value.__getValue(), landed: s.landed }));
`;
const run = (body) => app.eval(`${HELPERS}\n${body}`, { timeout: 30000 });

const closeAndRest = () => run(`
  return refill().then(() => {
    st().closeTab(open()[2]);
    return settle(900);
  }).then(() => showEach()).then(() => settle(300)).then(() => ({ slid: slides().length, rest: rest() }));
`);

const closeWithLateSlides = () => run(`
  return refill().then(() => {
    st().closeTab(open()[3]);
    return settle(40);
  }).then(() => {
    const running = slides().filter((s) => s.until && !s.landed);
    for (const s of running) s.until = Date.now() - 1;
    updateList();
    return settle(1200).then(() => showEach()).then(() => settle(300)).then(() => ({ late: running.length, rest: rest() }));
  });
`);

try {
  app = await launch(appPath, { data, port, session: fixture, onboarded: true });
  rep.log(`instance: pid ${app.pid}, DevTools port ${app.port}, data ${data}`);
  await run(`return settle(1500);`);
  await rep.check(`a tab closes: the rows below slide up and rest at 0 (${trials} tries)`, async () => {
    for (let n = 0; n < trials; n++) {
      const result = await closeAndRest();
      rep.log(`try ${n}: ${JSON.stringify(result)}`);
      assert.ok(result.slid > 0, `try ${n}: no row slid`);
      assert.deepEqual(result.rest, [], `try ${n}: ${result.rest.length} rows rest off their place`);
    }
  });
  await rep.check(`a tab closes and the list updates while the slides run late: they land at 0, no gap stays (${trials} tries)`, async () => {
    for (let n = 0; n < trials; n++) {
      const result = await closeWithLateSlides();
      rep.log(`try ${n}: ${JSON.stringify(result)}`);
      assert.ok(result.late > 0, `try ${n}: no slide was still running when the list updated`);
      assert.deepEqual(result.rest, [], `try ${n}: ${result.rest.length} rows rest off their place`);
    }
  });
} finally {
  await app?.quit();
  server.close();
  if (!keep) rmSync(data, { recursive: true, force: true });
  else rep.say(`data: ${data}`);
}
process.exit(rep.summary() ? 0 : 1);
