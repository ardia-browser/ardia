#!/usr/bin/env node
const HELP = `Usage: node scripts/engine-fake.mjs [--ui <dir>] [--out <dir>] [--onboarding] [--keep-open]
Runs the engine UI bundle (ui-chromium) in a headless Chromium against the fake bridge
(packages/expo-linux/src/chromium/fake), before the engine exists: the host page loads, opens its main window with
window.open, the window mounts and shows, a launch link opens a page through tab.create and tab.show, and the
command bar opened over it becomes a hole in the page. Builds the bundle first unless --ui is given. Writes the
window's screenshots and a report.json to --out and exits 1 when a check fails. Pages are served with the engine's
Content Security Policy (with ui/csp.json's script hashes); --onboarding leaves onboarding showing (the meadow), where
only the policy and page-error checks count.`;

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const here = fileURLToPath(new URL(".", import.meta.url));
const linux = resolve(here, "..");
const repo = resolve(linux, "../../..");
const out = resolve(option("--out") ?? mkdtempSync(join(tmpdir(), "ardia-engine-fake-")));
mkdirSync(out, { recursive: true });
let ui = option("--ui");
if (!ui) {
  ui = join(out, "ui");
  const built = spawnSync("npx", ["vite", "build", "--config", "renderer/vite.chromium.config.ts", "--logLevel", "warn"], { cwd: linux, env: { ...process.env, ARDIA_UI_OUT: ui }, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
ui = resolve(ui);

const fake = await build({ entryPoints: [join(repo, "packages/expo-linux/src/chromium/fake/install.ts")], bundle: true, format: "iife", write: false, target: "chrome140" });
const apiVersion = Number(/NATIVE_API_VERSION = (\d+)/.exec(readFileSync(join(repo, "apps/browser/src/platform/nativeApi.ts"), "utf8"))?.[1] ?? 0);
const onboarding = args.includes("--onboarding");
const seeded = onboarding ? {} : { "onboarding.json": JSON.stringify({ completedAt: 1, version: 1 }) };
const fakeScript = `globalThis.ardiaFakeApiVersion = ${apiVersion};\nglobalThis.ardiaFakeDocuments = ${JSON.stringify(seeded)};\n${fake.outputFiles[0].text}`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".woff2": "font/woff2" };
const cspFile = join(ui, "csp.json");
const scriptHashes = existsSync(cspFile) ? (JSON.parse(readFileSync(cspFile, "utf8")).scriptSrc ?? []) : [];
const ENGINE_CSP = [
  "child-src 'self' blob:",
  "connect-src 'self' data: blob: https://api.github.com https://github.com https://objects.githubusercontent.com https://release-assets.githubusercontent.com https://storage.googleapis.com",
  "default-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "frame-src 'self' about: data: blob:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  ["script-src 'self' 'wasm-unsafe-eval'", ...scriptHashes].join(" "),
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
  const file = join(ui, path);
  if (!file.startsWith(ui) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": ENGINE_CSP }).end(readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const executable = () => {
  const root = join(process.env.HOME ?? "", ".cache/ms-playwright");
  for (const revision of ["chromium-1248", "chromium-1234", "chromium-1228"]) {
    const path = join(root, revision, "chrome-linux64/chrome");
    if (existsSync(path)) return path;
  }
  return undefined;
};

const report = { checks: {}, errors: [], console: [], csp: [] };
const check = (name, ok, detail) => {
  report.checks[name] = { ok: !!ok, detail };
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const until = async (what, test, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
};

const browser = await chromium.launch({ executablePath: executable(), headless: true, args: ["--disable-popup-blocking"] });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript({ content: fakeScript });
  const host = await context.newPage();
  host.on("console", (message) => report.console.push(`${message.type()}: ${message.text()}`));
  host.on("pageerror", (error) => report.errors.push(String(error?.stack ?? error)));
  context.on("console", (message) => /Content Security Policy/.test(message.text()) && report.csp.push(message.text().slice(0, 300)));
  const popup = context.waitForEvent("page", { timeout: 20000 });
  await host.goto(`${origin}/index.html`);
  check("the host has the bridge", await host.evaluate(() => typeof window.ardiaLinux?.callSync === "function"));
  const win = await popup;
  await win.setViewportSize({ width: 1280, height: 800 });
  const engine = () => host.evaluate(() => {
    const fake = window.ardiaFakeEngine;
    return { shaped: fake.shaped, windowsShown: fake.windowsShown, verbs: fake.calls.map((call) => call.verb), shown: Object.fromEntries(fake.shown), slowSync: fake.syncCalls.filter((call) => call.ms > 2).length, syncCalls: fake.syncCalls.length };
  });
  const shownWindow = await until("the main window to show", async () => (await engine()).windowsShown[0]);
  check("the main window opened with window.open and showed after its first paint", shownWindow, shownWindow);
  check("the app window has no bridge of its own", await win.evaluate(() => !("ardiaLinux" in window)));
  await until("the UI to mount", () => win.evaluate(() => (document.getElementById("root")?.childElementCount ?? 0) > 0));
  await win.waitForTimeout(1500);
  await win.screenshot({ path: join(out, "1-window.png") });

  if (onboarding) {
    const meadow = await until("the meadow's scene", () => host.evaluate(() => window.ardiaFakeEngine.meadow), 15000).catch(() => null);
    check("the onboarding meadow's scene runs under the policy", meadow === "ready", meadow);
    await win.screenshot({ path: join(out, "2-onboarding.png") });
  } else {
  const fixture = "data:text/html,<title>Fixture</title><p>fixture";
  await host.evaluate((url) => window.ardiaLinuxDebug.emit("ArdiaShell", "onOpenURLs", { urls: [url] }), fixture);
  const placed = await until("tab.create and tab.show for the launch link", async () => {
    const now = await engine();
    const shown = Object.values(now.shown).find((show) => show.visible && show.width > 0);
    return now.verbs.includes("tab.create") && shown ? shown : null;
  });
  check("a launch link opens a page: tab.create, then tab.show with a rect", true, { x: placed.x, y: placed.y, width: placed.width, height: placed.height, radius: placed.radius });
  await win.waitForTimeout(800);
  await win.screenshot({ path: join(out, "2-page-placed.png") });
  const titled = await until("the page title in the sidebar", () => win.evaluate(() => document.body.innerText.includes("Fixture")), 8000).catch(() => false);
  check("navigation events reach the UI (the title shows)", titled);

  const holeCount = (shown) => Object.values(shown).reduce((count, show) => count + (show.visible && Array.isArray(show.holes) ? show.holes.length : 0), 0);
  const holesBefore = holeCount((await engine()).shown);
  await host.evaluate((id) => window.ardiaLinuxDebug.command("focusCommandBar", null, id), shownWindow);
  const holed = await until("a hole where the command bar covers the page", async () => {
    const shown = (await engine()).shown;
    return holeCount(shown) > holesBefore ? Object.values(shown).find((show) => show.visible && show.holes?.length) : null;
  }, 8000).catch(() => null);
  check("the command bar over the page is a hole in tab.show", holed, holed?.holes);
  await win.waitForTimeout(600);
  await win.screenshot({ path: join(out, "3-command-bar.png") });

  const frames = await host.evaluate(() => new Promise((done) => {
    let count = 0;
    const started = performance.now();
    const tick = () => (performance.now() - started < 1000 ? (count++, requestAnimationFrame(tick)) : done(count));
    requestAnimationFrame(tick);
  }));
  check("the host's requestAnimationFrame runs (forwarded to the app window)", frames > 20, `${frames} frames in 1 s`);
  const final = await engine();
  report.engine = { ...final, holesBefore };
  check("sync calls answer under 2 ms", final.slowSync === 0, `${final.syncCalls} sync calls`);
  }
  check("no page errors in the host", report.errors.length === 0, report.errors.slice(0, 3));
  check("nothing breaks the engine's Content Security Policy", report.csp.length === 0, report.csp.slice(0, 3));
} catch (error) {
  check("the run finished", false, String(error?.message ?? error));
} finally {
  failed = Object.values(report.checks).some((each) => !each.ok);
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report and screenshots in ${out}`);
  if (!args.includes("--keep-open")) await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
