import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, port, metroPort] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node symbol-geometry-test.mjs <ad hoc Debug Ardia.app> [cdpPort] [metroPort]");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "ac-symbol-geometry-"));
const data = join(scratch, "data"), probe = join(scratch, "geometry.json"), dylib = join(scratch, "probe.dylib");
mkdirSync(data);
const rep = reporter(join(scratch, "symbol-geometry-test.log"), { name: "symbol-geometry-test" });
const measurements = [];
execFileSync("clang", ["-fobjc-arc", "-dynamiclib", "-framework", "AppKit",
  join(dirname(fileURLToPath(import.meta.url)), "symbol-geometry-probe.m"), "-o", dylib]);
let app;
async function measure() {
  const after = Date.now();
  for (let i = 0; i < 100; i++) {
    try {
      const value = JSON.parse(readFileSync(probe, "utf8"));
      if (value.at >= after && value.frames.length) return value.frames;
    } catch {}
    await sleep(50);
  }
  throw new Error("no native symbol geometry received");
}
try {
  app = await launch(resolve(appArg), {
    data, port: port ? Number(port) : undefined, js: "live", metroPort: metroPort ? Number(metroPort) : undefined,
    onboarded: true, test: { keychain: true }, env: { DYLD_INSERT_LIBRARIES: dylib, ARDIA_SYMBOL_GEOMETRY: probe },
    session: session({ tabs: [{ id: "a", url: "about:blank", title: "Symbol geometry" }],
      windows: [{ id: "w1", activeTabIds: { default: "a" } }],
      settings: { appearance: "light", sidebarWidth: 239.5, searchSuggestions: false } }),
  });
  await app.eval(`
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
    globalThis.symbolFolder = ac.live.store.createFolder("default", "pullRequests");
    globalThis.symbolItems = [1, 2, 3].map((n) => ({ id: "pr" + n, source: "github", url: "https://example.invalid/pr/" + n,
      title: ["Checkmark and triangle", "Failing X and triangle", "Fixed triangle"][n - 1], subtitle: "", icon: null,
      updatedAt: 1000 - n, section: "authored", pr: { number: n, repo: "fixture/ardia", author: "test", authorAvatar: null,
        draft: false, headRef: "fixture", baseRef: "main", review: null, mergeable: "conflicting", checks: [],
        comments: 0, unresolvedThreads: 0, additions: 1, deletions: 1, changedFiles: 1 } }));
    ac.live.store.applyFetch(symbolFolder, symbolItems, {});
    ac.live.store.setStatus(symbolFolder, { state: "idle", lastFetch: Date.now(), error: null });
    return true;
  `);
  await sleep(1200);
  for (const [index, scale] of [1, 1.25, 1.1, 1, 1.5, 1].entries()) {
    await rep.check(`stage ${index}, interface scale ${scale}`, async () => {
      await app.eval(`ac.store.getState().updateSettings({ interfaceScale: ${scale} }); return true;`);
      await sleep(1200);
      const wrong = [];
      for (let change = 0; change <= 20; change++) {
        await app.eval(`
          const items = symbolItems.map((item, row) => ({ ...item, pr: { ...item.pr,
            mergeable: row === 2 || ${change % 2} === 0 ? "conflicting" : "unknown",
            checks: [{ name: "build", state: row === 1 ? "failure" : "success", url: null }] } }));
          ac.live.store.applyFetch(symbolFolder, items, {}); return true;
        `);
        await sleep(150);
        if ([0, 20].includes(change)) {
          await app.eval(`return ac.shell.devSnapshotWindow("w1", ${JSON.stringify(join(scratch, `stage-${index}-${change}.png`))});`);
        }
        const frames = await measure();
        measurements.push({ index, scale, change, frames });
        for (const frame of frames) {
          if (frame.frame.some((value, i) => Math.abs(value - frame.bounds[i]) > 0.001)) wrong.push({ change, ...frame });
        }
      }
      if (wrong.length) throw new Error(`${wrong.length} image frames differ from their symbol bounds: ${JSON.stringify(wrong.slice(0, 3))}`);
      return "21 changes, every image fills its symbol bounds, including hidden images";
    });
  }
} catch (error) {
  rep.record("setup", { error });
} finally {
  await app?.quit();
  writeFileSync(join(scratch, "measurements.json"), JSON.stringify(measurements, null, 2));
  rmSync(data, { recursive: true, force: true });
}
process.exit(rep.summary() ? 0 : 1);
