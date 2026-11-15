import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg || args.includes("--help")) {
  console.error("usage: node drag-region-test.mjs <Debug Ardia.app> [--port=<DevTools port>] [--every-mount]\n" +
    "  Title-bar drag regions rebuild lazily: after a layout change the pointer wasn't over, the window is stale,\n" +
    "  and it is rebuilt by the time a press can land (the pointer's arrival, a window move under it, or 2 s).\n" +
    "  --every-mount runs the dragRegionEveryMount experiment (the old behaviour) and prints its rebuild count.");
  process.exit(2);
}
const port = args.find((a) => a.startsWith("--port="))?.slice(7);
const everyMount = args.includes("--every-mount");
const scratch = mkdtempSync(join(tmpdir(), "ac-drag-region-"));
const tab = (id, n) => ({ id, windowId: "w1", url: "about:blank", title: `Tab ${n}`, lastActiveAt: n });
const fixture = session({
  windows: [{ id: "w1", tabIds: ["t1", "t2", "t3"], activeTabIds: { default: "t1" }, frame: [120, 120, 1280, 800] }],
  tabs: [tab("t1", 3), tab("t2", 2), tab("t3", 1)],
});

const HELPERS = `
const dev = globalThis.expo.modules.ArdiaDev;
const st = () => ac.store.getState();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const region = () => dev.devDragRegionState("w1");
const blocked = () => dev.devDragBlockedRects("w1");
const win = () => ac.engine.call("windows.list").then((ws) => ws.filter((w) => w.hasRoot)[0].window);
const act = (a) => win().then((n) => ac.engine.call("windows.dev", { window: n, action: a }));
const pointer = (x, top) => dev.devDragRegionPointer("w1", x, top, true);
const away = () => dev.devDragRegionPointer("w1", 600, 400, true);
const arrive = () => pointer(640, 14);
const out = {};
const keep = (name, value) => Promise.resolve(value).then((v) => { out[name] = v; });
const steps = (...fns) => fns.reduce((p, f) => p.then(f), Promise.resolve()).then(() => out);
const quiet = () => away().then(() => settle(2600));
const retitle = (n) => Array.from({ length: n }, (_, i) => i).reduce((p, i) => p.then(() => { st().updateTab("t2", { title: "T" + i }); return settle(150); }), Promise.resolve());
const addTab = () => void st().newTab("w1", { url: "about:blank", background: true });
`;

let app = null;
let failed = 0;
const check = async (name, fn) => {
  try {
    const note = await fn();
    console.log(`ok    ${name}${note ? `  (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").join("\n      ")}`);
  }
};
const run = (body, timeout = 30000) => app.eval(`${HELPERS}\n${body}`, { timeout });

const changes = {
  "a tab is added": `st().newTab("w1", { url: "about:blank", background: true });`,
  "the sidebar is resized": `st().updateSettings({ sidebarWidth: st().settings.sidebarWidth === 300 ? 260 : 300 });`,
  "the sidebar is hidden": `ac.runCommand({ command: "toggleSidebar", arg: null, windowId: "w1" });`,
  "the sidebar is shown again": `ac.runCommand({ command: "toggleSidebar", arg: null, windowId: "w1" });`,
  "a tab's title changes": `st().updateTab("t2", { title: "Changed " + Date.now() });`,
};

try {
  app = await launch(resolve(appArg), {
    data: join(scratch, "data"), port, session: fixture, onboarded: true, startTimeout: 180000, ready: { timeout: 240000 },
    switchOverrides: everyMount ? { dragRegionEveryMount: true } : undefined,
  });
  const first = await run(`return away().then(() => settle(3000)).then(() => Promise.all([region(), blocked()]));`);
  console.log(`region at rest: ${JSON.stringify(first[0])}; ${first[1].length} blocked rects`);

  if (everyMount) {
    const o = await run(`return steps(quiet, () => keep("rest", region()), () => retitle(40), () => keep("after", region()));`, 60000);
    console.log(`every mount: ${o.after.rebuilds - o.rest.rebuilds} rebuilds over 40 title changes in 6 s, ${o.after.deferred} deferred`);
  } else {
    for (const [name, change] of Object.entries(changes)) {
      await check(`${name} with the pointer away: once the pointer is in the title bar the region is the one a full rebuild gives`, async () => {
        const o = await run(`return steps(quiet, () => keep("rest", region()), () => { ${change} }, () => settle(${name.includes("sidebar is") ? 900 : 450}), () => keep("after", region()),
          arrive, () => settle(60), () => keep("arrived", region()),
          () => keep("probe", dev.devWindowMoveProbe("w1", { x: 640, top: 14, steps: 4, dx: 3, dy: 0, intervalMs: 8 })),
          () => keep("lazy", dev.devDragRegionRects("w1")), () => keep("fresh", blocked()));`, 40000);
        if (name.includes("title")) assert.ok(o.after.rebuilds - o.rest.rebuilds <= 1, `a title change rebuilt the region ${o.after.rebuilds - o.rest.rebuilds} times with the pointer away`);
        assert.equal(o.arrived.stale, false, "the pointer's arrival left the region stale");
        assert.equal(o.arrived.stalePresses, 0);
        assert.deepEqual(o.lazy, o.fresh, "the region the pointer's arrival left isn't the one a full rebuild gives");
        assert.equal(o.probe.serverOwnsPress, true, `the empty title bar at x 640 isn't the window server's to drag (hit ${o.probe.hit})`);
        return `${o.after.rebuilds - o.rest.rebuilds} rebuilds from the change, ${o.arrived.rebuilds - o.after.rebuilds} on arrival, ${o.fresh.length} blocked rects`;
      });
    }

    await check("the pointer already in the title bar: a change rebuilds within 0.45 s, as before", async () => {
      const o = await run(`return steps(() => pointer(640, 14), () => settle(2600), () => keep("rest", region()), addTab, () => settle(450), () => keep("after", region()));`);
      assert.equal(o.after.stale, false);
      assert.ok(o.after.rebuilds > o.rest.rebuilds, "no rebuild with the pointer in the title bar");
    });

    await check("a stale window moved under a still pointer is rebuilt by the move", async () => {
      const o = await run(`return steps(quiet, () => retitle(1), () => keep("stale", region()),
        () => { const f = st().windows.w1.frame; return dev.devSetWindowFrame("w1", [f[0] + 40, f[1] + 30, f[2], f[3]]); },
        () => settle(50), () => keep("movedAway", region()),
        () => pointer(640, 14), () => dev.devSetWindowFrame("w1", [200, 200, 1280, 800]).then(() => pointer(640, 14)).then(() => dev.devSetWindowFrame("w1", [201, 200, 1280, 800])),
        () => settle(50), () => keep("after", region()));`);
      assert.equal(o.stale.stale, true);
      assert.equal(o.movedAway.stale, true, "a move that leaves the pointer outside the title bar rebuilt the region");
      assert.equal(o.after.stale, false, "the window stayed stale after moving under the pointer");
    });

    await check("left alone, a stale window is rebuilt within 2 s anyway", async () => {
      const o = await run(`return steps(quiet, () => retitle(1), () => keep("stale", region()), () => settle(2100), () => keep("after", region()));`);
      assert.equal(o.stale.stale, true);
      assert.ok(o.after.rebuilds > o.stale.rebuilds, "no catch-up rebuild in 2.1 s");
    });

    await check("after a deferred change, the region the pointer's arrival leaves blocks and opens the same points as a full rebuild", async () => {
      const o = await run(`const xs = []; for (let x = 4; x < 1276; x += 4) xs.push(x);
        return steps(away, addTab, () => retitle(2), arrive, () => settle(60), () => keep("lazy", dev.devDragRegionRects("w1")), () => keep("fresh", blocked()),
          () => keep("hits", Promise.all(xs.map((x) => act("hit:" + x + ",14").then((h) => [x, h])))));`, 60000);
      assert.deepEqual(o.lazy, o.fresh);
      const inRect = (x, y) => o.fresh.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
      const regions = o.hits.filter(([, hit]) => /WindowDragRegion/.test(hit.split(" < ")[0]));
      const shut = regions.filter(([x]) => inRect(x, 14));
      assert.equal(shut.length, 0, `drag regions blocked at x ${shut.map(([x]) => x).join(", ")}`);
      const others = o.hits.filter(([, hit]) => !/WindowDragRegion/.test(hit.split(" < ")[0]));
      return `${regions.length} drag-region points open, ${others.filter(([x]) => inRect(x, 14)).length} of ${others.length} other points blocked, ${o.fresh.length} blocked rects`;
    });

    await check("idle with a tab retitling itself: one rebuild per 2 s at most, not one per change", async () => {
      const o = await run(`return steps(quiet, () => keep("rest", region()), () => retitle(40), () => keep("after", region()));`, 60000);
      const rebuilds = o.after.rebuilds - o.rest.rebuilds;
      assert.ok(rebuilds <= 5, `${rebuilds} rebuilds in 6 s`);
      return `${rebuilds} rebuilds over 40 title changes in 6 s`;
    });
  }
} finally {
  if (app) {
    await app.eval(`return globalThis.expo.modules.ArdiaDev.devDragRegionPointer("w1", 0, 0, false);`).catch(() => {});
    await app.quit().catch(() => {});
  }
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
