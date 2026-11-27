import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { launch } from "./dbHarness.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SHOTS = process.env.ONBOARDING_SHOTS ?? fileURLToPath(new URL("../../test-results/onboarding/", import.meta.url));
const BROWSERS = (process.env.ONBOARDING_BROWSERS ?? "chromium").split(",").filter(Boolean);
mkdirSync(SHOTS, { recursive: true });

const ARDIA_DARK = {
  "--ardia-background": "rgba(30,30,32,1)",
  "--ardia-text": "#FFFFFF",
  "--ardia-text-secondary": "#FFFFFF80",
  "--ardia-text-tertiary": "#FFFFFF59",
  "--ardia-placeholder": "#FFFFFF87",
  "--ardia-icon": "#F7F5FFC6",
  "--ardia-divider": "rgba(255,255,255,0.09)",
  "--ardia-row-hover": "rgba(255,255,255,0.07)",
  "--ardia-row-selected": "rgba(255,255,255,0.22)",
  "--ardia-accent": "#4A77D4",
  "--ardia-selection": "rgba(120,125,134,0.7)",
  "--ardia-popover-fill": "rgba(38,38,38,0.94)",
  "--ardia-popover-border": "rgba(255,255,255,0.14)",
  "--ardia-panel": "#2A2A2A",
  "--ardia-group-fill": "rgba(255,255,255,0.045)",
  "--ardia-form-accent": "#0A84FF",
  "--ardia-destructive": "#FF453A",
};
const ARDIA_LIGHT = {
  "--ardia-background": "rgba(255,255,255,1)",
  "--ardia-text": "#000000",
  "--ardia-text-secondary": "#00000080",
  "--ardia-text-tertiary": "#00000059",
  "--ardia-placeholder": "#00000066",
  "--ardia-icon": "#000000C6",
  "--ardia-divider": "rgba(0,0,0,0.09)",
  "--ardia-row-hover": "rgba(0,0,0,0.07)",
  "--ardia-row-selected": "rgba(15,24,44,0.08)",
  "--ardia-accent": "#6395FC",
  "--ardia-selection": "rgba(120,125,134,0.4)",
  "--ardia-popover-fill": "rgba(255,255,255,0.96)",
  "--ardia-popover-border": "rgba(0,0,0,0.12)",
  "--ardia-panel": "#FFFFFF",
  "--ardia-group-fill": "rgba(0,0,0,0.028)",
  "--ardia-form-accent": "#007AFF",
  "--ardia-destructive": "#FF3B30",
};


function themeScript(vars, scheme) {
  const css = `:root{color-scheme:${scheme};${Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join("")}}`;
  return `(() => { const add = () => { if (document.getElementById("ardia-theme")) return; const s = document.createElement("style"); s.id = "ardia-theme"; s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).prepend(s); }; if (document.documentElement) add(); else document.addEventListener("readystatechange", add, { once: true }); })();`;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function startDev() {
  if (process.env.NOTES_DEV_URL) return { url: process.env.NOTES_DEV_URL, stop: async () => {} };
  const port = await freePort();
  const child = spawn(process.execPath, ["build.mjs", "--dev"], { cwd: root, env: { ...process.env, NOTES_DEV_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dev server exited: ${log}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`dev server did not start: ${log}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dev.js`, { method: "HEAD" });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    },
  };
}

async function until(fn, what, ms = 8000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${last}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

let server;
before(async () => {
  server = await startDev();
});
after(async () => {
  await server?.stop();
});

for (const name of BROWSERS) {
  describe(`onboarding and import (${name})`, () => {
    let browser;
    before(async () => {
      browser = await launch(name);
    });
    after(async () => {
      await browser?.close();
    });

    async function open(query, scheme = "light") {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
      await context.addInitScript(themeScript(scheme === "dark" ? ARDIA_DARK : ARDIA_LIGHT, scheme));
      const page = await context.newPage();
      page.errors = [];
      page.on("pageerror", (e) => page.errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && !/favicon|ResizeObserver/.test(m.text()) && page.errors.push(m.text()));
      await page.goto(`${server.url}/?reset${query ? `&${query}` : ""}`);
      return { context, page };
    }

    const shot = async (page, file) => {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/${file}.png` });
    };

    const step = (page) => page.locator('[data-testid="onboarding"]').getAttribute("data-step");
    const stats = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ardia-notes-stats") || "{}"));

    for (const scheme of ["light", "dark"]) {
      test(`first run walks every step with an import, resumes after reload (${scheme})`, async () => {
        const { context, page } = await open("empty", scheme);
        await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
        assert.equal(await step(page), "welcome");
        const nameInput = page.getByTestId("onboarding-name");
        await until(() => nameInput.evaluate((el) => el === document.activeElement), "name focused");
        await nameInput.fill("Ada Lovelace");
        await page.getByTestId("onboarding-swatch").nth(7).click();
        await until(async () => (await page.getByTestId("onboarding-avatar").textContent()) === "A", "avatar initial");
        await shot(page, `${scheme}-1-welcome`);
        await nameInput.press("Enter");
        await until(async () => (await step(page)) === "import", "import step");
        assert.equal((await page.evaluate(() => window.notesClient.me())).name, "Ada Lovelace");
        const tiles = await page.locator('[data-testid="import-sources"] [data-grid-item]').evaluateAll((els) => els.map((el) => el.dataset.testid));
        assert.deepEqual(tiles, ["import-source-notion", "import-source-obsidian", "import-source-evernote", "import-source-apple-notes", "import-source-fresh"]);
        assert.equal(await page.locator('[data-testid="import-source-notion"] svg.n-brand-mark').count(), 1);
        await page.locator('[data-testid="import-source-apple-notes"] [data-testid="import-app-icon"]').waitFor();
        await shot(page, `${scheme}-2-import`);
        await page.getByTestId("import-source-notion").click();
        await page.getByTestId("import-detail").waitFor();
        await page.getByTestId("notion-account").waitFor();
        const detail = await page.getByTestId("import-detail").innerText();
        assert.match(detail, /Signed in as Ada Lovelace/);
        assert.doesNotMatch(detail, /export|email/i);
        assert.equal(await page.getByTestId("notion-spaces").getByRole("radio").count(), 2);
        assert.equal(await page.getByTestId("notion-use-file").innerText(), "Choose a file instead");
        await shot(page, `${scheme}-2b-import-source`);
        await page.getByTestId("notion-import").click();
        await page.getByTestId("notion-import-progress").waitFor();
        await until(async () => /Reading your workspace… \d+ of \d+ pages/.test(await page.getByTestId("notion-import-line").innerText()), "pages read so far");
        assert.doesNotMatch(await page.getByTestId("notion-import-progress").innerText(), /export|email/i);
        await page.screenshot({ path: `${SHOTS}/${scheme}-2b2-notion-reading.png` });
        await page.getByTestId("import-progress").waitFor({ timeout: 15_000 });
        await until(async () => Number(await page.getByTestId("import-bar").getAttribute("aria-valuenow")) > 20, "progress moves");
        await page.screenshot({ path: `${SHOTS}/${scheme}-2c-import-progress.png` });
        await until(async () => (await page.getByTestId("import-progress").getAttribute("data-phase")) === "done", "import done", 10_000);
        assert.ok(Number(await page.getByTestId("import-count-pages").innerText()) > 0);
        await shot(page, `${scheme}-2d-import-done`);
        await page.getByTestId("onboarding-continue").click();
        await until(async () => (await step(page)) === "template", "template step");
        await page.getByTestId("onboarding-template-task-list").click();
        await page.getByTestId("template-preview").waitFor();
        await shot(page, `${scheme}-3-template`);
        await page.reload();
        await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
        assert.equal(await step(page), "template");
        assert.equal(await page.getByTestId("onboarding-template-task-list").getAttribute("aria-checked"), "true");
        await page.getByTestId("onboarding-continue").click();
        await until(async () => (await step(page)) === "together", "together step", 10_000);
        await shot(page, `${scheme}-4-together`);
        await page.getByTestId("onboarding-create-shared").click();
        await page.getByTestId("onboarding-shared").waitFor();
        assert.ok((await page.evaluate(() => window.notesClient.workspaces())).some((w) => w.shared && /Ada/.test(w.name)));
        await shot(page, `${scheme}-4b-together-created`);
        await page.getByTestId("onboarding-continue").click();
        await until(async () => (await step(page)) === "agents", "agents step");
        await page.getByTestId("onboarding-continue").click();
        const tour = page.getByTestId("tour");
        await tour.waitFor();
        await until(() => page.locator(".n-page-column .bn-editor").count(), "getting started editor");
        assert.match(await page.title(), /Getting Started/);
        assert.equal(await tour.getAttribute("data-stop"), "slash");
        await shot(page, `${scheme}-5a-tour-slash`);
        await page.getByTestId("tour-try").click();
        await page.waitForTimeout(300);
        await page.keyboard.type("/");
        await until(async () => (await tour.getAttribute("data-stop")) === "markdown", "slash detected");
        await page.keyboard.press("Escape");
        await page.keyboard.press("Backspace");
        await shot(page, `${scheme}-5b-tour-markdown`);
        await page.keyboard.type("# Hello");
        await until(async () => (await tour.getAttribute("data-stop")) === "links", "markdown detected");
        await page.keyboard.press("Enter");
        await page.keyboard.type("@");
        await until(async () => (await tour.getAttribute("data-stop")) === "address", "mention detected");
        await page.keyboard.press("Escape");
        await shot(page, `${scheme}-5c-tour-address`);
        await page.getByTestId("tour-next").click();
        assert.equal(await tour.getAttribute("data-stop"), "database");
        await page.getByTestId("tour-try").click();
        await page.waitForTimeout(300);
        await page.keyboard.type("/board");
        await page.getByTestId("slash-menu").waitFor();
        await page.keyboard.press("Enter");
        await until(async () => (await tour.getAttribute("data-stop")) === "finale", "database detected", 10_000);
        await shot(page, `${scheme}-5d-tour-finale`);
        await page.getByTestId("tour-open-template").click();
        await until(async () => !(await tour.count()), "tour closes");
        await until(async () => /Task/.test(await page.title()), "task list open");
        const counts = await stats(page);
        for (const key of ["onboarding.shown", "onboarding.done", "onboarding.step.import.reached", "onboarding.step.tour.reached", "import.source.notion", "template.task-list", "tour.slash.done", "tour.database.done"]) assert.ok(counts[key] >= 1, `stat ${key}`);
        assert.equal(counts["onboarding.step.template.reached"], 1);
        assert.ok(Object.values(counts).every((v) => typeof v === "number"));
        await page.reload();
        await page.waitForSelector(".n-sidebar", { timeout: 30_000 });
        await page.waitForTimeout(800);
        assert.equal(await page.getByTestId("onboarding").count(), 0);
        assert.deepEqual(page.errors, []);
        await context.close();
      });
    }

    async function toAgents(page) {
      await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
      await page.getByTestId("onboarding-continue").click();
      await until(async () => (await step(page)) === "import", "import step");
      await page.getByTestId("onboarding-skip").click();
      await until(async () => (await step(page)) === "template", "template step");
      await page.getByTestId("onboarding-template-blank").click();
      await page.getByTestId("onboarding-continue").click();
      await until(async () => (await step(page)) === "together", "together step", 10_000);
      await page.getByTestId("onboarding-skip").click();
      await until(async () => (await step(page)) === "agents", "agents step");
      await page.getByTestId("agents-step").waitFor();
    }

    for (const scheme of ["light", "dark"]) {
      test(`agents step: status flips, copy, demo streams into a page (${scheme})`, async () => {
        const { context, page } = await open("empty&agentDemoMs=2400", scheme);
        if (name === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
        await toAgents(page);
        assert.match(await page.getByTestId("onboarding-eyebrow").innerText(), /05 \/ 06/i);
        await until(async () => (await page.getByTestId("agents-command").getAttribute("data-on")) === "false", "status loads");
        await shot(page, `${scheme}-5-agents`);
        await page.getByTestId("agents-command-open").click();
        await until(async () => (await page.getByTestId("agents-command").getAttribute("data-on")) === "true", "command ticks green", 6000);
        await page.getByTestId("agents-control-open").click();
        await until(async () => (await page.getByTestId("agents-control").getAttribute("data-on")) === "true", "control ticks green", 6000);
        if (name === "chromium") {
          await page.getByTestId("agents-prompt").nth(1).click();
          await until(async () => /copied/i.test(await page.getByTestId("agents-prompt").nth(1).innerText()), "prompt copied");
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Summarise this week’s journal");
          await page.getByTestId("agents-copy-setup").focus();
          await page.keyboard.press("Enter");
          await until(async () => /copied/i.test(await page.getByTestId("agents-copy-setup").innerText()), "setup copied");
          const snippet = await page.evaluate(() => navigator.clipboard.readText());
          assert.match(snippet, /ardia plugins call notes describe/);
          assert.match(snippet, /"topic":"markdown"/);
          await page.getByTestId("agents-prompt").nth(2).focus();
          await page.keyboard.press("Space");
          await until(async () => (await page.evaluate(() => navigator.clipboard.readText())).startsWith("Import my Obsidian"), "space copies");
        }
        await page.getByTestId("agents-demo-run").click();
        await until(() => page.getByTestId("agents-demo-page").count(), "live page appears", 6000);
        await until(async () => (await page.getByTestId("agents-demo-step").count()) === 6, "steps listed");
        await page.screenshot({ path: `${SHOTS}/${scheme}-5b-agents-demo-running.png` });
        await until(async () => (await page.getByTestId("agents-demo").getAttribute("data-state")) === "done", "demo done", 8000);
        assert.match(await page.getByTestId("agents-demo-page").innerText(), /This week/);
        await shot(page, `${scheme}-5c-agents-demo-done`);
        await page.getByTestId("agents-demo-open").click();
        await page.getByTestId("tour").waitFor();
        await until(async () => /Agent demo/.test(await page.title()), "demo page open");
        const counts = await stats(page);
        for (const key of ["onboarding.step.agents.reached", "agents.settings.plugins", "agents.settings.advanced", "agents.demo.run"]) assert.ok(counts[key] >= 1, `stat ${key}`);
        if (name === "chromium") for (const key of ["agents.prompt.1.copied", "agents.prompt.2.copied", "agents.setup.copied"]) assert.ok(counts[key] >= 1, `stat ${key}`);
        assert.deepEqual(page.errors, []);
        await context.close();
      });
    }

    test("agents step: unknown status, skip, Esc and Tab", async () => {
      const { context, page } = await open("empty&agentUnknown");
      await toAgents(page);
      await until(async () => /Check:/.test(await page.getByTestId("agents-command").innerText()), "unknown status explains");
      for (let i = 0; i < 16; i++) {
        await page.keyboard.press("Tab");
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest(".n-ob-card")), "focus stays in the card");
      }
      await page.keyboard.press("Escape");
      await until(async () => (await step(page)) === "together", "Esc goes back");
      await page.getByTestId("onboarding-skip").click();
      await until(async () => (await step(page)) === "agents", "agents again");
      await page.getByTestId("onboarding-skip").click();
      await page.getByTestId("tour").waitFor();
      assert.equal((await stats(page))["onboarding.step.agents.skipped"], 1);
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test("skip setup, then reopen from Settings", async () => {
      const { context, page } = await open("empty");
      await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
      await page.getByTestId("onboarding-skip-all").click();
      await until(async () => !(await page.getByTestId("onboarding").count()), "onboarding closes");
      await page.getByTestId("import-empty").waitFor();
      await shot(page, "light-empty-home");
      await page.reload();
      await page.getByTestId("import-empty").waitFor({ timeout: 30_000 });
      assert.equal(await page.getByTestId("onboarding").count(), 0);
      await page.getByTestId("nav-settings").click();
      await page.getByTestId("settings-welcome").click();
      await page.getByTestId("onboarding").waitFor();
      assert.equal(await step(page), "welcome");
      const counts = await stats(page);
      assert.equal(counts["onboarding.skipped"], 1);
      assert.equal(counts["onboarding.step.welcome.skipped"], 1);
      assert.equal(counts["onboarding.replayed"], 1);
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test("Browse all templates hides onboarding behind the gallery and comes back", async () => {
      const { context, page } = await open("empty");
      await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
      await page.getByTestId("onboarding-continue").click();
      await until(async () => (await step(page)) === "import", "import step");
      await page.getByTestId("onboarding-skip").click();
      await until(async () => (await step(page)) === "template", "template step");
      await page.getByTestId("onboarding-browse-templates").click();
      await page.getByTestId("template-gallery").waitFor();
      assert.equal(await page.getByTestId("onboarding").count(), 0);
      await page.keyboard.press("Escape");
      await until(async () => !(await page.getByTestId("template-gallery").count()), "gallery closes");
      await page.getByTestId("onboarding").waitFor();
      assert.equal(await step(page), "template");
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test("with sites unsupported, Notion shows the export flow and says live import is coming", async () => {
      const { context, page } = await open("empty&notion=unsupported");
      await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
      await page.getByTestId("onboarding-name").press("Enter");
      await until(async () => (await step(page)) === "import", "import step");
      await page.getByTestId("import-source-notion").click();
      await page.getByTestId("import-detail").waitFor();
      await page.getByTestId("import-detail-note").waitFor();
      assert.equal(await page.getByTestId("import-detail-note").innerText(), "Live import from Notion is coming soon — import a Notion export instead.");
      assert.equal(await page.getByTestId("notion-account").count(), 0);
      assert.equal(await page.getByTestId("notion-import").count(), 0);
      assert.equal(await page.getByTestId("import-choose").isEnabled(), true);
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test("keyboard: Enter, arrows in the grid, Esc goes back", async () => {
      const { context, page } = await open("empty");
      await page.getByTestId("onboarding").waitFor({ timeout: 30_000 });
      await until(() => page.getByTestId("onboarding-name").evaluate((el) => el === document.activeElement), "name focused");
      await page.keyboard.press("Enter");
      await until(async () => (await step(page)) === "import", "import step");
      await page.getByTestId("import-source-notion").focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "import-source-obsidian");
      await page.keyboard.press("End");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "import-source-fresh");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "import-source-apple-notes");
      await page.keyboard.press("Enter");
      await page.getByTestId("import-detail").waitFor();
      assert.equal(await page.getByTestId("import-choose").innerText(), "Import from Notes");
      await page.keyboard.press("Escape");
      await until(async () => (await step(page)) === "welcome", "back to welcome");
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => !!document.activeElement?.closest(".n-ob-card"));
        assert.ok(inside, "focus stays in the card");
      }
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test("an existing workspace gets no onboarding", async () => {
      const { context, page } = await open("");
      await page.waitForSelector(".bn-editor", { timeout: 30_000 });
      await page.waitForTimeout(800);
      assert.equal(await page.getByTestId("onboarding").count(), 0);
      await context.close();
    });

    for (const scheme of ["light", "dark"]) {
      test(`import sheet from the sidebar opens the imported page (${scheme})`, async () => {
        const { context, page } = await open("importMs=1200", scheme);
        await page.waitForSelector(".bn-editor", { timeout: 30_000 });
        await page.getByTestId("nav-import").click();
        await page.getByTestId("import-sheet").waitFor();
        assert.equal(await page.locator('[data-testid="import-sources"] [data-grid-item]').count(), 4);
        assert.equal(await page.getByTestId("import-source-markdown").count(), 0);
        await shot(page, `${scheme}-sheet-1-sources`);
        await page.getByTestId("import-show-others").click();
        const others = await page.locator('[data-testid="import-other-sources"] [data-grid-item]').evaluateAll((els) => els.map((el) => el.dataset.testid.replace("import-source-", "")));
        assert.deepEqual(others, ["markdown", "logseq", "bear", "roam", "keep", "joplin", "simplenote", "craft"]);
        await until(async () => (await page.evaluate(() => document.activeElement?.dataset.testid)) === "import-source-markdown", "focus moves to the first other format");
        await shot(page, `${scheme}-sheet-1b-other-formats`);
        await page.getByTestId("import-source-markdown").click();
        assert.equal(await page.getByTestId("import-choose").innerText(), "Choose folder…");
        assert.equal(await page.getByTestId("import-choose-other").innerText(), "Choose a file instead");
        await shot(page, `${scheme}-sheet-2-detail`);
        await page.getByTestId("import-choose-other").click();
        await page.getByTestId("import-progress").waitFor();
        await until(async () => Number(await page.getByTestId("import-bar").getAttribute("aria-valuenow")) >= 25, "progress");
        await page.screenshot({ path: `${SHOTS}/${scheme}-sheet-3-progress.png` });
        await until(async () => /Markdown & text import/.test(await page.title()), "navigates to import root", 10_000);
        await until(async () => !(await page.getByTestId("import-sheet").count()), "sheet closes");
        assert.ok(await page.getByTestId("tree-row").filter({ hasText: "Markdown & text import" }).count());
        assert.deepEqual(page.errors, []);
        await context.close();
      });
    }

    for (const scheme of ["light", "dark"]) {
      test(`Apple Notes imports from the app in one click (${scheme})`, async () => {
        const { context, page } = await open(scheme === "dark" ? "noAppIcon" : "", scheme);
        await page.waitForSelector(".bn-editor", { timeout: 30_000 });
        await page.evaluate(() => {
          const client = window.notesClient;
          const call = client.call.bind(client);
          window.__calls = [];
          client.call = (op, args) => {
            window.__calls.push({ op, args });
            return call(op, args);
          };
        });
        await page.getByTestId("nav-import").click();
        await page.getByTestId("import-sheet").waitFor();
        if (scheme === "dark") await page.locator('[data-testid="import-source-apple-notes"] .n-imp-notes-tile').waitFor();
        else await page.locator('[data-testid="import-source-apple-notes"] [data-testid="import-app-icon"]').waitFor();
        await page.getByTestId("import-source-apple-notes").click();
        assert.equal(await page.getByTestId("import-choose").innerText(), "Import from Notes");
        assert.equal(await page.getByTestId("import-choose-other").innerText(), "Choose an exported folder instead");
        await shot(page, `${scheme}-sheet-2b-apple-notes`);
        await page.getByTestId("import-choose").click();
        await page.getByTestId("import-progress").waitFor();
        const starts = await page.evaluate(() => window.__calls.filter((c) => c.op === "importStart").map((c) => c.args));
        assert.equal(starts.length, 1);
        assert.equal(starts[0].source, "apple-notes");
        assert.equal(starts[0].pick, "app");
        assert.deepEqual(page.errors, []);
        await context.close();
      });
    }

    test("import failure shows the error and Try again; cancel works; Settings opens the sheet", async () => {
      const { context, page } = await open("importFail&importMs=6000");
      await page.waitForSelector(".bn-editor", { timeout: 30_000 });
      await page.getByTestId("nav-settings").click();
      await page.getByTestId("settings-import").click();
      await page.getByTestId("import-sheet").waitFor();
      await page.getByTestId("import-source-evernote").click();
      assert.equal(await page.getByTestId("import-choose-other").count(), 0);
      await page.getByTestId("import-choose").click();
      await page.getByTestId("import-error").waitFor({ timeout: 8000 });
      await shot(page, "light-sheet-4-failed");
      await page.getByTestId("import-retry").click();
      await page.getByTestId("import-cancel").click();
      await until(async () => (await page.getByTestId("import-progress").getAttribute("data-phase")) === "cancelled", "cancelled");
      await page.keyboard.press("Escape");
      await page.getByTestId("import-detail").waitFor();
      await page.keyboard.press("Escape");
      await until(async () => !(await page.getByTestId("import-sheet").count()), "sheet closes on Esc");
      assert.deepEqual(page.errors, []);
      await context.close();
    });
  });
}
