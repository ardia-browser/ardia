import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../../node_modules/playwright/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SHOTS = process.env.NOTES_SHOTS ?? fileURLToPath(new URL("../../test-results/templates/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const THEMES = {
  light: { "--ardia-background": "rgba(255,255,255,1)", "--ardia-text": "#000000", "--ardia-text-secondary": "#00000080", "--ardia-divider": "rgba(0,0,0,0.09)", "--ardia-row-hover": "rgba(0,0,0,0.07)", "--ardia-popover-fill": "rgba(255,255,255,0.96)", "--ardia-form-accent": "#007AFF" },
  dark: { "--ardia-background": "rgba(30,30,32,1)", "--ardia-text": "#FFFFFF", "--ardia-text-secondary": "#FFFFFF80", "--ardia-divider": "rgba(255,255,255,0.09)", "--ardia-row-hover": "rgba(255,255,255,0.07)", "--ardia-popover-fill": "rgba(38,38,38,0.94)", "--ardia-form-accent": "#0A84FF" },
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function startServer() {
  if (process.env.NOTES_DEV_URL) return { url: process.env.NOTES_DEV_URL, stop: () => {} };
  const port = await freePort();
  const child = spawn(process.execPath, ["build.mjs", "--dev"], { cwd: root, env: { ...process.env, NOTES_DEV_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("dev server exited");
    try {
      if ((await fetch(`http://127.0.0.1:${port}/dev.js`)).ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("dev server did not start");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGTERM") };
}

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

after(async () => {
  await browser?.close();
  server?.stop();
});

async function open(scheme = "light") {
  const context = await browser.newContext({ viewport: { width: 1360, height: 880 }, colorScheme: scheme });
  const css = `:root{color-scheme:${scheme};${Object.entries(THEMES[scheme]).map(([k, v]) => `${k}:${v};`).join("")}}`;
  await context.addInitScript(`(() => { const add = () => { if (document.getElementById("ardia-theme")) return; const s = document.createElement("style"); s.id = "ardia-theme"; s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).prepend(s); }; if (document.documentElement) add(); else document.addEventListener("readystatechange", add, { once: true }); })();`);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|ResizeObserver/.test(m.text()) && page.errors.push(m.text()));
  await page.goto(`${server.url}/?reset`);
  await page.waitForSelector(".bn-editor", { timeout: 30_000 });
  await page.waitForTimeout(300);
  return { context, page };
}

const counts = (page) => page.evaluate(() => window.notesClient.call("counts", {}));
const templateIds = (page) => page.evaluate(() => [...document.querySelectorAll("[data-testid=template-card]")].map((el) => el.getAttribute("data-template")));

async function waitFor(check, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function openGallery(page) {
  await page.getByTestId("nav-templates").click();
  await page.getByTestId("template-gallery").waitFor();
}

async function previewReady(page) {
  const frame = page.getByTestId("template-preview");
  await frame.waitFor({ timeout: 10_000 });
  await waitFor(async () => (await frame.locator(".bn-block-content, [data-testid=db-page]:not([data-testid=db-loading])").count()) > 0, 10_000, "preview content");
  return frame;
}

describe("template gallery", () => {
  test("opens from the sidebar, filters by category and search, and previews", async () => {
    const { context, page } = await open();
    await openGallery(page);
    const all = await templateIds(page);
    assert.ok(all.length >= 40, `${all.length} cards`);
    await page.getByTestId("template-section-school").click();
    const school = await templateIds(page);
    assert.ok(school.includes("flashcards") && !school.includes("project-tracker"));
    await page.getByTestId("template-search").fill("kanban");
    await waitFor(async () => (await templateIds(page)).includes("project-tracker"), 4000, "search result");
    assert.ok((await templateIds(page)).length < all.length);
    await page.getByTestId("template-search").press("Enter");
    const frame = await previewReady(page);
    assert.ok(await frame.locator("[data-testid=db-page]").count() >= 1, "preview shows live databases");
    assert.equal(await frame.locator(".bn-editor[contenteditable=true]").count(), 0, "preview is read-only");
    await page.keyboard.press("Escape");
    await page.getByTestId("template-grid").waitFor();
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("template-gallery").count()) === 0, 4000, "gallery closed");
    const c = await counts(page);
    assert.equal(c.template_gallery_opens_sidebar, 1);
    assert.equal(c.template_previews, 1);
    assert.equal(c.template_searches, 1);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  test("every built-in template renders in the live preview", async () => {
    const { context, page } = await open();
    await openGallery(page);
    const ids = await templateIds(page);
    const failed = [];
    for (const id of ids) {
      await page.locator(`[data-testid=template-card][data-template="${id}"]`).click();
      try {
        const frame = await previewReady(page);
        const blocks = await frame.locator(".bn-block-content").count();
        const dbs = await frame.locator("[data-testid=db-page]").count();
        if (!blocks && !dbs) failed.push(`${id}: empty preview`);
      } catch (error) {
        failed.push(`${id}: ${error.message}`);
      }
      if (page.errors.length) failed.push(`${id}: ${page.errors.splice(0).join(" | ")}`);
      await page.getByTestId("template-back").click();
      await page.getByTestId("template-grid").waitFor();
    }
    assert.deepEqual(failed, []);
    await context.close();
  });

  test("using a template adds it as a top-level page and opens it", async () => {
    const { context, page } = await open();
    await openGallery(page);
    await page.locator("[data-testid=template-card][data-template=reading-list]").click();
    await previewReady(page);
    await page.getByTestId("template-add-to").click();
    await page.getByTestId("menu-template-target-top").click();
    await page.getByTestId("template-use").click();
    await page.getByTestId("template-gallery").waitFor({ state: "detached" });
    await waitFor(async () => (await page.locator("[data-testid=db-page]").count()) > 0, 10_000, "database page");
    await waitFor(async () => (await page.getByTestId("tree-row").filter({ hasText: "Reading list" }).count()) > 0, 5000, "sidebar row");
    await waitFor(async () => (await page.locator("[data-testid=db-page] [data-row], [data-testid=db-page] [data-testid=db-card], [data-testid=db-page] [data-testid=db-gallery-card]").count()) > 0, 8000, "sample rows");
    const c = await counts(page);
    assert.equal(c.template_uses_reading_list, 1);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  test("save a page as a template, find it under Your templates, and use it", async () => {
    const { context, page } = await open();
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).first().click();
    await page.getByTestId("page-more").click();
    await page.getByTestId("menu-template").click();
    await waitFor(async () => (await page.locator(".n-toast").filter({ hasText: "as a template" }).count()) > 0, 5000, "toast");
    await openGallery(page);
    await page.getByTestId("template-section-yours").click();
    const card = page.getByTestId("template-own-card").filter({ hasText: "Meeting Notes" });
    await card.waitFor();
    await card.click();
    await previewReady(page);
    await page.getByTestId("template-add-to").click();
    await page.getByTestId("menu-template-target-top").click();
    await page.getByTestId("template-use").click();
    await page.getByTestId("template-gallery").waitFor({ state: "detached" });
    await waitFor(async () => (await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).count()) >= 2, 8000, "copy in sidebar");
    const c = await counts(page);
    assert.equal(c.template_saves, 1);
    assert.equal(c.template_uses_yours, 1);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  test("a database's New menu browses templates and makes a row", async () => {
    const { context, page } = await open();
    await openGallery(page);
    await page.locator("[data-testid=template-card][data-template=project-tracker]").click();
    await previewReady(page);
    await page.getByTestId("template-add-to").click();
    await page.getByTestId("menu-template-target-top").click();
    await page.getByTestId("template-use").click();
    await page.getByTestId("template-gallery").waitFor({ state: "detached" });
    const block = page.locator("[data-testid=db-block]").first();
    await block.waitFor({ timeout: 10_000 });
    const before = await block.locator("[data-testid=db-card], [data-testid=db-row]").count();
    await block.getByTestId("db-new-more").click();
    await page.getByTestId("db-browse-templates").click();
    await page.getByTestId("template-gallery").waitFor();
    await page.getByTestId("template-search").fill("meeting");
    await page.locator("[data-testid=template-card][data-template=meeting-notes]").click();
    await previewReady(page);
    await page.getByTestId("template-use").click();
    await page.getByTestId("template-gallery").waitFor({ state: "detached" });
    await waitFor(async () => (await block.locator("[data-testid=db-card], [data-testid=db-row]").count()) > before, 8000, "new row");
    assert.equal((await counts(page)).template_gallery_opens_database, 1);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  test("screenshots in light and dark", async () => {
    for (const scheme of ["light", "dark"]) {
      const { context, page } = await open(scheme);
      await openGallery(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/gallery-${scheme}.png` });
      for (const id of ["project-tracker", "journal", "eisenhower-matrix"]) {
        const card = page.locator(`[data-testid=template-card][data-template="${id}"]`);
        if (!(await card.count())) continue;
        await card.click();
        await previewReady(page);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${SHOTS}/preview-${id}-${scheme}.png` });
        await page.getByTestId("template-back").click();
      }
      assert.deepEqual(page.errors, []);
      await context.close();
    }
  });
});
