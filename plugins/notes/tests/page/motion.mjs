import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const out = args.shots ?? fileURLToPath(new URL("../../test-results/page/motion/", import.meta.url));
mkdirSync(out, { recursive: true });
const browsers = (args.browser ?? "chromium,webkit").split(",");
const mod = process.platform === "darwin" ? "Meta" : "Control";
const TIMES = [0, 50, 100, 200];

async function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["build.mjs", "--dev"], { cwd: root, env: { ...process.env, NOTES_DEV_PORT: String(port) }, stdio: "ignore" });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/dev.js`)).ok) break;
    } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error("dev server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGTERM") };
}

const launch = (name) =>
  name === "webkit"
    ? webkit.launch().catch(() => webkit.launch({ executablePath: `${homedir()}/Library/Caches/ms-playwright/webkit-2388/pw_run.sh` }))
    : chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));

async function capture(page, tag, name, action, probe) {
  await action();
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.pause();
  });
  const values = [];
  for (const t of TIMES) {
    const value = await page.evaluate(
      ({ t, probe }) => {
        for (const a of document.getAnimations()) {
          const timing = a.effect?.getComputedTiming?.();
          const end = Number(timing?.endTime ?? 0);
          a.currentTime = Math.min(t, Math.max(0, end - 0.001));
        }
        const el = [...document.querySelectorAll(probe.selector)].at(probe.last ? -1 : 0);
        if (!el) return null;
        const cs = getComputedStyle(el);
        if (probe.prop === "height" || probe.prop === "width") return Math.round(el.getBoundingClientRect()[probe.prop]);
        return cs[probe.prop];
      },
      { t, probe },
    );
    values.push(value);
    await page.screenshot({ path: `${out}/${tag}-${name}-${String(t).padStart(3, "0")}ms.png` });
  }
  const running = await page.evaluate(() => document.getAnimations().length);
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        a.play();
      }
    }
  });
  await page.waitForTimeout(350);
  const nums = values.map((v) => (v === null ? null : parseFloat(String(v))));
  const moving = nums[0] !== null && nums[1] !== null && nums[1] !== nums[0] && (nums[3] === null || nums[1] !== nums[3]);
  return { name, probe: probe.prop, values, animations: running, ok: running > 0 && (probe.loose || moving) };
}

async function scenario(browser, url, tag) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/?reset`);
  await page.waitForSelector(".n-page-column .bn-editor");
  await page.waitForTimeout(600);
  const results = [];
  const run = async (name, action, probe) => {
    try {
      results.push(await capture(page, tag, name, action, probe));
    } catch (e) {
      results.push({ name, probe: probe.prop, values: [String(e.message).split("\n")[0]], animations: 0, ok: false });
      await page.keyboard.press("Escape").catch(() => {});
    }
  };

  await run("slash-open", async () => {
    await page.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
    await page.waitForTimeout(150);
    await page.keyboard.type("/");
    await page.waitForSelector('[data-testid="slash-menu"]');
  }, { selector: ".n-slash", prop: "opacity" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);

  await run("block-menu-open", async () => {
    await page.locator(".n-page-column .bn-block-content").filter({ hasText: "Press / to see" }).hover();
    await page.getByTestId("drag-handle").click();
    await page.waitForSelector('[data-testid="block-menu"]');
  }, { selector: ".n-popover[data-popover-id]", prop: "opacity", last: true });
  await run("block-menu-close", async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".n-ghost.is-leaving", { state: "attached" });
  }, { selector: ".n-ghost.is-leaving", prop: "opacity", last: true });
  await page.waitForTimeout(200);

  await run("search-open", async () => {
    await page.getByTestId("page-title").click();
    await page.keyboard.press(`${mod}+k`);
    await page.waitForSelector('[data-testid="search-modal"]');
  }, { selector: ".n-modal-scrim", prop: "opacity" });
  await run("search-close", async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".n-ghost.is-modal-leaving", { state: "attached" });
  }, { selector: ".n-ghost.is-modal-leaving", prop: "opacity" });
  await page.waitForTimeout(200);

  await run("tree-expand", async () => {
    const row = page.getByTestId("tree-row").filter({ hasText: "Trip to Lisbon" });
    await row.hover();
    await row.getByTestId("tree-chevron").click();
  }, { selector: ".n-tree-children", prop: "height", last: true });
  await run("tree-collapse", async () => {
    const row = page.getByTestId("tree-row").filter({ hasText: "Trip to Lisbon" });
    await row.hover();
    await row.getByTestId("tree-chevron").click();
  }, { selector: ".n-tree-children", prop: "height", last: true });
  await page.waitForTimeout(250);

  await run("comments-open", async () => {
    await page.getByTestId("comments-toggle").click();
    await page.waitForSelector('[data-testid="comments-panel"]');
  }, { selector: ".n-side-panel", prop: "width" });
  await run("comments-close", async () => {
    await page.getByTestId("comments-toggle").click();
  }, { selector: ".n-side-panel", prop: "width" });
  await page.waitForTimeout(250);

  await run("sidebar-collapse", async () => {
    await page.keyboard.press(`${mod}+\\`);
  }, { selector: ".n-sidebar", prop: "width" });
  await page.keyboard.press(`${mod}+\\`);
  await page.waitForTimeout(400);

  await run("toast", async () => {
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await page.waitForTimeout(400);
    await page.getByTestId("page-more").click();
    await page.getByTestId("menu-copy-link").click();
    await page.waitForSelector(".n-toast:not(.n-ghost)");
  }, { selector: ".n-toast:not(.n-ghost)", prop: "opacity" });

  await run("page-switch", async () => {
    await page.getByTestId("tree-row").filter({ hasText: "Reading List" }).click();
    await page.waitForSelector(".n-ghost.is-page-leaving", { state: "attached" });
  }, { selector: ".n-ghost.is-page-leaving", prop: "opacity" });
  await page.waitForTimeout(300);

  await run("todo-check", async () => {
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await page.waitForTimeout(500);
    await page.locator('.n-page-column [data-content-type="checkListItem"] input').first().click();
  }, { selector: '.n-page-column [data-content-type="checkListItem"][data-checked="true"] .bn-inline-content', prop: "color" });

  await run("cover-add", async () => {
    await page.getByTestId("page-title").hover();
    await page.getByTestId("add-cover").click();
    await page.waitForSelector('[data-testid="cover"]');
  }, { selector: ".n-cover", prop: "height" });

  await run("db-view-open", async () => {
    await page.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
    await page.waitForTimeout(150);
    await page.keyboard.type("/Board view");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.n-page-column [data-testid="db-view"]', { timeout: 10000 });
  }, { selector: '.n-page-column [data-testid="db-view"]', prop: "opacity", loose: true });

  await run("db-peek-open", async () => {
    await page.locator('.n-page-column [data-testid="db-block"]').getByTestId("db-new").click();
    await page.waitForSelector('[data-testid="db-peek"]');
  }, { selector: ".db-peek", prop: "opacity" });
  await run("db-peek-close", async () => {
    await page.getByTestId("db-peek-close").click();
    await page.waitForSelector(".n-ghost.is-peek-leaving", { state: "attached" });
  }, { selector: ".n-ghost.is-peek-leaving", prop: "opacity" });

  await page.waitForTimeout(300);
  await run("tree-new-row", async () => {
    await page.getByTestId("sidebar-new-page").click();
    await page.waitForSelector('[data-testid="tree-row"].is-selected');
  }, { selector: '[data-testid="tree-row"].is-selected', prop: "opacity" });

  await run("block-type", async () => {
    await page.keyboard.type("Motion");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.type("# ");
    await page.waitForSelector('.n-page-column [data-content-type="heading"]');
  }, { selector: '.n-page-column [data-content-type="heading"]', prop: "opacity" });

  await run("slash-filter", async () => {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);
    await page.keyboard.type("/");
    await page.waitForSelector('[data-testid="slash-menu"]');
    await page.waitForTimeout(250);
    await page.keyboard.type("to");
    await page.waitForTimeout(16);
  }, { selector: '[data-testid="slash-menu"] [data-flip]', prop: "opacity", loose: true });
  await page.keyboard.press("Escape");

  await run("tree-row-leave", async () => {
    const row = page.getByTestId("tree-row").filter({ hasText: "Motion" });
    await row.hover();
    await row.getByTestId("tree-more").click();
    await page.getByTestId("menu-delete").click();
    await page.waitForSelector(".n-ghost.is-row-leaving", { state: "attached" });
  }, { selector: ".n-ghost.is-row-leaving", prop: "opacity" });

  await context.close();
  return { results, errors };
}

const server = await startServer();
const report = {};
let failed = 0;
try {
  for (const name of browsers) {
    const browser = await launch(name);
    const { results, errors } = await scenario(browser, server.url, name);
    await browser.close();
    report[name] = { results, errors };
    for (const r of results) {
      if (!r.ok) failed++;
      console.log(`${r.ok ? "ok  " : "FAIL"} ${name.padEnd(8)} ${r.name.padEnd(18)} ${r.probe.padEnd(8)} ${JSON.stringify(r.values)} anims=${r.animations}`);
    }
    if (errors.length) {
      failed++;
      console.log(`page errors (${name}):\n  ${errors.join("\n  ")}`);
    }
  }
} finally {
  server.stop();
}
writeFileSync(`${out}/motion.json`, JSON.stringify(report, null, 2));
console.log(`\n${failed ? `${failed} problems` : "all transitions animated"}. Frames: ${out}`);
process.exit(failed ? 1 : 0);
