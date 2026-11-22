import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg || args.includes("--help")) {
  console.error("usage: node freeze-watch-test.mjs <Debug Ardia.app> [--metro=<port>] [--keep] [--skip-renderer]\n" +
    "  Blocks the main thread (devBlockMain) and the JS thread (ac.blockJs) for 300 ms, 1.2 s and 6 s, one at a time,\n" +
    "  and checks each lands in its bucket of the hourly freeze counts; a garbage-heavy JS block shows its GC time;\n" +
    "  with sharing off nothing is counted; a page whose input handler spins 22 s after a real click is counted as\n" +
    "  unresponsive 5-30 s (no DevTools session on that page: Chrome ignores a hang while one is attached).");
  process.exit(2);
}
const metroPort = Number(args.find((a) => a.startsWith("--metro="))?.slice(8) ?? 8081);
const keep = args.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "ac-freeze-watch-"));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const BUCKETS = { 300: "250_500ms", 1200: "1_2s", 6000: "5_10s" };
const page = `<!doctype html><title>spin</title><body style="height:2000px">
<script>addEventListener("mousedown", () => { const until = Date.now() + 22000; while (Date.now() < until) {} });</script>`;
const server = await new Promise((r) => {
  const s = createServer((q, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
  s.listen(0, "127.0.0.1", () => r(s));
});

const inst = await launch(appArg, { data: join(scratch, "data"), fresh: true, onboarded: true, metroPort });
const take = () => inst.eval("return ac.freezes.takeFreezeCounts(acTelemetry.store.getState().epoch)", { timeout: 30000 });
const settle = async (ms) => {
  await sleep(ms + 400);
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(200)) if (await inst.eval("return true", { timeout: 5000 }).catch(() => false)) return;
};
const block = (thread, ms, garbage = false) =>
  thread === "main"
    ? inst.eval(`return expo.modules.ArdiaDev.devBlockMain(${ms})`)
    : inst.eval(`return ac.blockJs(${ms}, ${garbage})`);

try {
  await inst.eval("acTelemetry.setSharing(false, 'settings'); return true");
  await block("main", 1200);
  await settle(1200);
  await block("js", 1200);
  await settle(1200);
  const off = await take();
  check("sharing off: nothing is counted or sent", JSON.stringify(off) === "{}", JSON.stringify(off));

  await inst.eval("acTelemetry.setSharing(true, 'settings'); return true");
  await sleep(1500);
  const afterOn = await take();
  check("stalls from while sharing was off aren't sent after it turns on", (afterOn.main_stall_1_2s ?? 0) === 0 && (afterOn.js_stall_1_2s ?? 0) === 0, `main ${afterOn.main_stall_1_2s}, js ${afterOn.js_stall_1_2s}`);

  for (const thread of ["main", "js"])
    for (const ms of [300, 1200, 6000]) {
      await take();
      await block(thread, ms);
      await settle(ms);
      const counts = await take();
      const bucket = `${thread}_stall_${BUCKETS[ms]}`;
      const longest = counts[`${thread}_stall_longest_ms`];
      check(`${thread} blocked ${ms} ms → ${bucket}`, counts[bucket] === 1 && longest >= ms && longest < ms + 600, `${bucket}=${counts[bucket]}, longest ${longest} ms`);
    }

  await take();
  await block("js", 1200, true);
  await settle(1200);
  const gc = await take();
  check(
    "a garbage-heavy JS block shows its collections and the GC time inside the stall",
    gc.js_stall_1_2s === 1 && gc.js_stall_gc_measured === 1 && gc.js_stall_gc_ms > 0 && gc.js_gc_count > 0 && gc.js_gc_ms >= gc.js_stall_gc_ms,
    `gc in stall ${gc.js_stall_gc_ms} ms (bound ${gc.js_stall_gc_bound}), ${gc.js_gc_count} collections, ${gc.js_gc_ms} ms in the period, heap floor ${gc.js_heap_mb_floor} MB`,
  );

  if (!args.includes("--skip-renderer")) {
    const url = `http://127.0.0.1:${server.address().port}/spin`;
    await inst.eval(`ac.actions.openUrls([${JSON.stringify(url)}]); return true`);
    for (const end = Date.now() + 20000; Date.now() < end; await sleep(250))
      if ((await (await fetch(`http://127.0.0.1:${inst.port}/json`)).json()).some((t) => t.type === "page" && t.url.startsWith(url))) break;
    await sleep(2000);
    await take();
    await inst.eval("const w = ac.store.getState().windowOrder[0]; return expo.modules.ArdiaDev.devClick(w, { in: 'page', x: 100, y: 100, wait: 50 })", { timeout: 40000 });
    let shown = false;
    for (const end = Date.now() + 40000; Date.now() < end; await sleep(500)) {
      const unresponsive = await inst.eval("return Object.values(ac.pageState.getState().pages).some((p) => p?.unresponsive)").catch(() => false);
      if (unresponsive) shown = true;
      if (shown && !unresponsive) break;
    }
    await sleep(1000);
    const hang = await take();
    check("a page whose input handler spins 22 s is counted as unresponsive for 5-30 s", shown && hang.renderer_unresponsive === 1 && hang.renderer_unresponsive_5_30s === 1, `shown ${shown}, ${JSON.stringify(Object.fromEntries(Object.entries(hang).filter(([k]) => k.startsWith("renderer_"))))}`);
  }
} finally {
  if (!keep) await inst.quit();
  server.close();
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
