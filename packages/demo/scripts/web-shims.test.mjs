import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

test("web shims survive ticker failures, reject inherited palettes and enter a view under a still pointer", { timeout: 30_000 }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ardia-web-shims-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const server = await createServer({
    cacheDir,
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${server.resolvedUrls.local[0]}tests/web-shims.html`);
  await page.getByRole("button", { name: "Run checks" }).click();
  await page.waitForFunction(() => document.getElementById("results")?.textContent);
  const results = JSON.parse(await page.locator("#results").textContent());
  t.diagnostic(JSON.stringify(results));
  assert.deepEqual(results.checks, {
    pointerBeforeSubscriber: true,
    inheritedPalette: true,
    validPalette: true,
    clockSurvivesThrow: true,
    enterOnMount: true,
  });
});
