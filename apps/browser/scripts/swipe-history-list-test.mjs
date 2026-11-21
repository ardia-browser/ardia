import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node swipe-history-list-test.mjs <Debug Ardia.app> [--js=pinned|live|host:port]");
  process.exit(2);
}
const js = args.find((a) => a.startsWith("--js="))?.slice("--js=".length) ?? "pinned";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${req.url}</title><h1>${req.url}</h1>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/page`;
const data = join(mkdtempSync(join(tmpdir(), "ac-swipe-history-")), "data");
const owned = await launch(resolve(appArg), {
  data,
  js,
  onboarded: true,
  session: session({ tabs: [{ id: "t1", url: `${base}/1`, title: "1" }] }),
});
const ac = (body, timeout = 20000) => owned.eval(body, { timeout });
const page = async () => Number((await ac("return ac.store.getState().tabs.t1?.url ?? '';")).split("/").pop());

async function visit(...pages) {
  for (const n of pages) {
    await ac(`ac.store.getState().navigate("t1", ${JSON.stringify(`${base}/${n}`)}); return true;`);
    for (let i = 0; i < 50 && (await page()) !== n; i++) await sleep(100);
    assert.equal(await page(), n, `page ${n} should load`);
    await sleep(300);
  }
}
async function swipe(steps) {
  const result = await ac(`return globalThis.acSwipe.pane("t1").devSimulate(${JSON.stringify(steps)}, {ignorePreference:true});`, 30000);
  assert.ok(!result?.error, `the swipe should run: ${result?.error}`);
  await sleep(1200);
  return page();
}
const moves = (count, dx, dy = 0) => Array.from({ length: count }, () => ({ phase: "changed", dx, dy }));
const hold = (ms) => ({ phase: "changed", dx: 0, dy: 0, delayMs: ms });
const cases = {
  "a quick swipe goes back one page": { from: [2, 3, 4], steps: [{ phase: "began" }, ...moves(12, 9), { phase: "ended" }], expect: 3 },
  "a swipe pulled back before the list opens stays": { from: [2, 3, 4], steps: [{ phase: "began" }, ...moves(12, 9), ...moves(12, -8), { phase: "ended" }], expect: 4 },
  "holding opens the list and moving down picks two back": { from: [2, 3, 4], steps: [{ phase: "began" }, ...moves(12, 9), hold(700), ...moves(8, 0, 11), { phase: "ended" }], expect: 2 },
  "a swipe pulled back after the list opened stays": { from: [2, 3, 4], steps: [{ phase: "began" }, ...moves(12, 9), hold(700), ...moves(8, 0, 11), ...moves(12, -8), { phase: "ended" }], expect: 4 },
};
let failed = 0;
try {
  for (let i = 0; i < 50 && !(await ac('return !!globalThis.acSwipe?.pane("t1");')); i++) await sleep(100);
  for (const [name, { from, steps, expect }] of Object.entries(cases)) {
    try {
      await visit(1, ...from);
      const landed = await swipe(steps);
      assert.equal(landed, expect, `landed on page ${landed}, expected ${expect}`);
      console.log(`ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
} finally {
  await owned.quit().catch(() => {});
  server.close();
  rmSync(data, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
