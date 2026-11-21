#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { devtools, launch, sleep } from "../../../scripts/lib/instance.mjs";

const usage = `usage: fingerprint-check.mjs <Ardia.app> [scratch dir]
Checks, in one hidden instance, what a page can read about this Mac's hardware (chromium-helium-noise-common-hardware.patch,
chromium-device-memory-cap.patch): on two sites, in the page, a same-site iframe and a dedicated worker (the core count
also in an about:blank frame and in its navigator once the frame is removed),
navigator.hardwareConcurrency is the common value for this machine's cores (8 from 8 up, 4 from 4, else 2),
navigator.deviceMemory and the Device-Memory client hint are at most 8, and WebGL's UNMASKED_RENDERER_WEBGL (WebGL 1 and 2, and WebGL 2 on an OffscreenCanvas in a worker)
on an Apple GPU is Chrome's string for the common chip of its generation (M1, M2, or M4 for M3 and later), the
generation read from the GPU's name as the engine reads it.
Any build: it reads pages over DevTools only.`;
const [appArg, scratchArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const scratch = resolve(scratchArg ?? join(process.env.TMPDIR ?? "/tmp", `ac-fingerprint-check-${process.pid}`));
rmSync(scratch, { recursive: true, force: true });

const chip = JSON.parse(execFileSync("system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf8" }))
  .SPDisplaysDataType?.[0]?.sppci_model ?? "";
const generation = Number(/^Apple M(\d+)/.exec(chip)?.[1] ?? 0);
const commonChip = generation === 1 ? "M1" : generation === 2 ? "M2" : generation >= 3 ? "M4" : null;
const APPLE_RENDERER = commonChip && `ANGLE (Apple, ANGLE Metal Renderer: Apple ${commonChip}, Unspecified Version)`;
const commonCores = (n) => (n >= 8 ? 8 : n >= 4 ? 4 : 2);
function approximatedMemory(bytes) {
  const mb = Math.floor(bytes / 1048576);
  const lower = 2 ** Math.floor(Math.log2(mb));
  const nearest = mb - lower <= lower * 2 - mb ? lower : lower * 2;
  return Math.min(8, Math.max(2, nearest / 1024));
}
const expectedCores = commonCores(cpus().length);
const expectedMemory = approximatedMemory(totalmem());

const WORKER = `
const canvas = new OffscreenCanvas(4, 4);
const gl = canvas.getContext("webgl2");
const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
postMessage({
  cores: navigator.hardwareConcurrency,
  memory: navigator.deviceMemory,
  renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
});`;
const PAGE = `<!doctype html><title>Fingerprint check</title><body><iframe id="frame" src="/frame"></iframe><script>
const read = (kind, doc = document) => {
  const gl = doc.createElement("canvas").getContext(kind);
  const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? { renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) } : null;
};
window.readAll = async () => {
  await new Promise((r) => (frame.contentDocument?.readyState === "complete" ? r() : frame.addEventListener("load", r, { once: true })));
  const worker = await new Promise((resolve) => {
    const w = new Worker("/worker.js");
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => resolve({ error: e.message || "worker failed" });
  });
  const hint = await (await fetch("/hint", { cache: "no-store" })).json();
  const f = frame.contentWindow;
  const blank = document.body.appendChild(document.createElement("iframe"));
  const detached = blank.contentWindow.navigator;
  const blankCores = detached.hardwareConcurrency;
  blank.remove();
  return {
    page: { cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, webgl: read("webgl"), webgl2: read("webgl2") },
    frame: { cores: f.navigator.hardwareConcurrency, memory: f.navigator.deviceMemory, webgl: read("webgl", f.document) },
    blank: { cores: blankCores, detached: detached.hardwareConcurrency },
    worker,
    hint,
  };
};
</script>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/worker.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(WORKER);
  if (path === "/hint") {
    const memory = req.headers["sec-ch-device-memory"] ?? req.headers["device-memory"] ?? null;
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ memory: memory === null ? null : Number(memory) }));
  }
  res.writeHead(200, { "content-type": "text/html", "accept-ch": "Sec-CH-Device-Memory, Device-Memory", "cache-control": "no-store" });
  res.end(path === "/frame" ? "<!doctype html><title>frame</title><p>frame" : PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const sites = [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`];

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const until = async (what, fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};

console.log(`this Mac: ${chip}, ${cpus().length} cores, ${Math.round(totalmem() / 1073741824)} GB; expecting ${expectedCores} cores, ${expectedMemory} GB, ${commonChip ?? "the real GPU name"}`);
const app = await launch(appArg, { data: join(scratch, "data"), js: process.env.JS ?? "none", onboarded: true, ready: false });
try {
  const browser = await until("DevTools", () => app.browser(), 60000);
  for (const url of sites) {
    await browser.send("Target.createTarget", { url });
    const target = await until(`the page at ${url}`, async () => (await app.targets()).find((t) => t.type === "page" && t.url === url));
    const page = await devtools(target);
    try {
      await until(`${url} loaded`, () => page.eval("document.readyState === 'complete' && typeof readAll === 'function'"));
      await page.eval("location.reload()").catch(() => null);
      await until(`${url} reloaded`, () => page.eval("document.readyState === 'complete' && typeof readAll === 'function'"));
      const r = await page.eval("readAll()", { timeout: 20000 });
      const site = new URL(url).hostname;
      const cores = [r.page.cores, r.frame.cores, r.worker.cores, r.blank.cores, r.blank.detached];
      check(`${site}: hardwareConcurrency in the page, an iframe, a worker, an about:blank frame and once detached`, cores.every((c) => c === expectedCores), cores.join(", "));
      const memory = [r.page.memory, r.frame.memory, r.worker.memory];
      check(`${site}: deviceMemory in the page, an iframe and a worker`, memory.every((m) => m === expectedMemory), memory.join(", "));
      check(`${site}: the Device-Memory client hint`, r.hint.memory === expectedMemory, String(r.hint.memory));
      const renderers = [r.page.webgl?.renderer, r.page.webgl2?.renderer, r.frame.webgl?.renderer, r.worker.renderer];
      const apple = !!APPLE_RENDERER && (r.page.webgl?.vendor ?? "").includes("Apple");
      check(`${site}: UNMASKED_RENDERER_WEBGL in WebGL 1, 2, an iframe and a worker's OffscreenCanvas`,
        apple ? renderers.every((x) => x === APPLE_RENDERER) : renderers.every((x) => typeof x === "string" && x.length > 0), renderers.join(" | "));
      check(`${site}: UNMASKED_VENDOR_WEBGL`, !apple || r.page.webgl.vendor === "Google Inc. (Apple)", r.page.webgl?.vendor);
    } finally {
      page.close();
    }
  }
} catch (e) {
  check("ran to the end", false, e.message);
} finally {
  await app.quit().catch(() => app.kill());
  server.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
