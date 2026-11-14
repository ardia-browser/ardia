import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const [appArg] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node live-folder-fold-test.mjs <Debug Ardia.app>");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "ac-live-folder-fold-"));
const rep = reporter(join(scratch, "results.log"), { name: "live-folder-fold-test" });
let app;
try {
  app = await launch(resolve(appArg), {
    data: join(scratch, "data"), onboarded: true,
    session: session({
      windows: [{ activeTabIds: { default: "a" } }],
      tabs: ["a", "b", "below"].map((id) => ({ id, url: `about:blank#${id}`, title: id })),
    }),
  });
  for (const kind of ["item", "stray", "stack"]) {
    await rep.check(`a never-shown ${kind} folds into a folder mounted collapsed`, async () => {
      const evidence = await app.eval(`
          const kind = ${JSON.stringify(kind)};
          const s = () => ac.store.getState();
          const live = ac.live.store;
          const folder = live.createFolder("default", "pullRequests");
          const item = (id) => ({ id, source: "github", url: "about:blank#" + id, title: id, subtitle: "", icon: null, updatedAt: 1 });
          const items = [item("a")];
          if (kind !== "stray") items.push(item("b"));
          if (kind === "stack") {
            items.push(item("c"));
            for (const [i, it] of items.slice(1).entries()) it.pr = {
              number: i + 1, repo: "fixture/repo", author: "fixture", authorAvatar: null, draft: false,
              headRef: it.id, baseRef: "main", review: null, mergeable: "mergeable", checks: [], comments: 0,
              unresolvedThreads: 0, additions: 1, deletions: 0, changedFiles: 1, stack: { id: "stack", position: i + 1 },
            };
          }
          live.applyFetch(folder, items, {});
          live.setStatus(folder, { state: "idle", lastFetch: Date.now(), error: null });
          s().updateTab("a", { liveItem: { folderId: folder, itemId: "a" } });
          s().updateTab("b", { liveItem: { folderId: folder, itemId: "b" } });
          ac.actions.switchToTab("a");
          live.updateFolder(folder, { collapsed: true });
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const measure = () => ac.sidebarRows.measureRow("w1", "below");
          return wait(600).then(measure).then((before) => {
            if (!before) throw new Error("row below the folder is missing");
            const samples = [before.y];
            const started = performance.now();
            const frame = () => {
              if (performance.now() - started >= 450) return Promise.resolve();
              return new Promise((r) => requestAnimationFrame(r)).then(measure).then((row) => {
                if (!row) throw new Error("row below the folder disappeared");
                samples.push(row.y);
                return frame();
              });
            };
            ac.actions.switchToTab("b");
            return frame().then(() => {
              const active = s().windows.w1.activeTabIds.default;
              live.removeFolder(folder);
              return wait(200).then(() => ({ active, samples }));
            });
          });
      `, { timeout: 15000 });
      rep.log(evidence);
      assert.equal(evidence.active, "b");
      const ys = evidence.samples;
      assert.ok(ys.length >= 5, "not enough animation frames");
      const low = Math.min(ys[0], ys.at(-1));
      const high = Math.max(ys[0], ys.at(-1));
      const overshoot = Math.max(0, ...ys.map((y) => Math.max(low - y, y - high)));
      assert.ok(overshoot <= 1, `row below overshot by ${overshoot} pt`);
      if (kind === "stack") {
        assert.ok(high - low > 10, "the expanded stack did not grow the folder");
        assert.ok(ys.filter((y) => y > low + 1 && y < high - 1).length >= 3, "the stack snapped to its full height");
      } else assert.ok(high - low <= 1, "replacing equally tall rows moved the row below");
      return { frames: ys.length, overshoot };
    });
  }
} catch (error) {
  rep.record("setup", { error });
} finally {
  await app?.quit();
  rmSync(join(scratch, "data"), { recursive: true, force: true });
}
process.exitCode = rep.summary() ? 0 : 1;
