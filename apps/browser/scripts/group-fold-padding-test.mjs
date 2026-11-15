import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const [appArg] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node group-fold-padding-test.mjs <Debug Ardia.app>");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "ac-group-fold-padding-"));
const rep = reporter(join(scratch, "results.log"), { name: "group-fold-padding-test" });
let app;
try {
  app = await launch(resolve(appArg), {
    data: join(scratch, "data"), onboarded: true,
    session: session({
      windows: [{ activeTabIds: { default: "direct" } }],
      tabs: ["inside", "direct", "below"].map((id) => ({ id, url: `about:blank#${id}`, title: id })),
      groups: [
        { id: "outer", windowId: "w1", profileId: "default", name: "Outer", collapsed: true, tabIds: ["inside", "direct"], shownTabIds: ["inside", "direct"], createdAt: 1 },
        { id: "inner", windowId: "w1", profileId: "default", parentId: "outer", name: "Inner", collapsed: true, tabIds: ["inside"], shownTabIds: ["inside"], createdAt: 2 },
      ],
    }),
  });
  await rep.check("hiding a nested first row eases its top gap while the active direct tab stays", async () => {
    const result = await app.eval(`
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const row = (id) => ac.sidebarRows.measureRow("w1", id);
      globalThis.sidebarMotionScale = 3;
      return pause(600).then(() => Promise.all([row("outer"), row("direct")])).then(([header, direct]) => {
        if (!header || !direct) throw new Error("fixture rows did not mount");
        return ac.engine.call("windows.list").then((windows) => {
          const window = windows.find((w) => w.hasRoot).window;
          const at = (header.x + 50) + "," + (header.y + header.height / 2);
          return ac.engine.call("windows.dev", { window, action: "mouse:down:" + at }).then(() => {
            const samples = [direct.y];
            const started = performance.now();
            const frame = () => {
              if (performance.now() - started >= 800) return Promise.resolve();
              return new Promise((r) => requestAnimationFrame(r)).then(() => row("direct")).then((r) => {
                if (!r) throw new Error("the retained tab disappeared");
                samples.push(r.y);
                return frame();
              });
            };
            return ac.engine.call("windows.dev", { window, action: "mouse:up:" + at }).then(frame).then(() => {
              const s = ac.store.getState();
              return { samples, collapsed: s.groups.outer.collapsed, shown: s.groups.outer.shownTabIds || [], active: s.windows.w1.activeTabIds.default };
            });
          });
        });
      });
    `, { timeout: 15000 });
    rep.log(result);
    assert.equal(result.collapsed, true);
    assert.equal(result.active, "direct");
    assert.ok(!result.shown.includes("inside"), "header click did not hide the nested row");
    const ys = result.samples;
    const end = ys.at(-1);
    assert.ok(ys[0] - end > 20, "the nested group did not fold away");
    assert.ok(ys.some((y) => y > end + 0.25 && y < end + 2.75), "the last 3 pt of padding snapped instead of easing");
    return { frames: ys.length, end };
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  await app?.quit();
  rmSync(join(scratch, "data"), { recursive: true, force: true });
}
process.exitCode = rep.summary() ? 0 : 1;
