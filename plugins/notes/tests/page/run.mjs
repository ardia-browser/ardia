import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { expect } from "playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const shots = args.shots ?? process.env.NOTES_SHOTS ?? fileURLToPath(new URL("../../test-results/page/", import.meta.url));
mkdirSync(shots, { recursive: true });
const browsers = (args.browser ?? "chromium,webkit").split(",");
const only = args.only ? args.only.split(",") : null;
const mod = process.platform === "darwin" ? "Meta" : "Control";

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
  const port = Number(args.port ?? (await freePort()));
  if (args.port) return { url: `http://127.0.0.1:${port}`, stop: () => {} };
  const frozen = mkdtempSync(join(tmpdir(), "notes-page-"));
  const child = spawn(process.execPath, ["build.mjs", "--dev", `--frozen=${frozen}`], { cwd: root, env: { ...process.env, NOTES_DEV_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("dev server exited");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) {
        const js = await fetch(`http://127.0.0.1:${port}/dev.js`);
        if (js.ok) break;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error("dev server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => (child.kill("SIGTERM"), rmSync(frozen, { recursive: true, force: true })) };
}

function launcher(name) {
  if (name === "webkit") {
    const fallback = `${homedir()}/Library/Caches/ms-playwright/webkit-2388/pw_run.sh`;
    return () => webkit.launch().catch(() => webkit.launch({ executablePath: fallback }));
  }
  return () => chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
}

function liveLocators(page) {
  const original = page.locator.bind(page);
  page.locator = (selector, options) => {
    if (typeof selector !== "string" || !selector.includes(".") || selector.includes(">>")) return original(selector, options);
    const live = selector
      .split(/,(?![^(]*\))/)
      .map((part) => `${part.trim()}:not(.n-ghost):not(.n-ghost *)`)
      .join(", ");
    return original(live, options);
  };
  return page;
}

async function open(browser, url, { scheme = "light", theme = true, as } = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: scheme });
  if (theme) await context.addInitScript(themeScript(scheme === "dark" ? ARDIA_DARK : ARDIA_LIGHT, scheme));
  const page = await context.newPage();
  liveLocators(page);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|ResizeObserver/.test(m.text()) && page.errors.push(m.text()));
  await page.goto(`${url}/?reset${as ? `&as=${as}` : ""}`);
  await page.waitForSelector(".bn-editor", { timeout: 30_000 });
  await page.waitForTimeout(400);
  return { context, page };
}

const editor = (page) => page.locator(".n-page-column .bn-editor").first();
const blocks = (page, type) => page.locator(`.n-page-column .bn-block-content[data-content-type="${type}"], .n-page-column [data-node-type="${type}"]`);

async function newPage(page, title = "") {
  await page.getByTestId("sidebar-new-page").click();
  const titleEl = page.getByTestId("page-title");
  await expect(titleEl).toBeFocused();
  if (title) await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
}

async function cursorBlock(page) {
  return page.evaluate(() => {
    const node = document.getSelection()?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const content = el?.closest(".bn-block-content");
    const depth = content ? content.closest(".bn-block-group")?.parentElement?.closest(".bn-block-group") ? 1 : 0 : 0;
    return { type: content?.getAttribute("data-content-type") ?? "", depth };
  });
}

async function toParagraph(page) {
  for (let i = 0; i < 4; i++) {
    const { type, depth } = await cursorBlock(page);
    if (type === "paragraph" && depth === 0) return;
    if (type === "paragraph") await page.keyboard.press("Shift+Tab");
    else await page.keyboard.press("Backspace");
  }
}

async function recordMotion(page) {
  await page.evaluate(() => {
    window.__motion = [];
    if (window.__motionPatched) return;
    window.__motionPatched = true;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const tags = [this.getAttribute("data-flip") !== null ? "flip" : "", this.getAttribute("data-testid") ?? "", String(this.className ?? "")];
      window.__motion?.push(tags.join(" "));
      return animate.apply(this, args);
    };
  });
}

async function animatedSince(page, tag) {
  return page.evaluate((t) => (window.__motion ?? []).filter((line) => line.split(" ").includes(t)).length, tag);
}

async function settled(page, selector) {
  await page.waitForTimeout(450);
  const state = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)].filter((el) => !el.closest(".n-ghost"));
    return {
      count: els.length,
      running: els.filter((el) => el.getAnimations().some((a) => a.playState === "running")).length,
      faded: els.filter((el) => Number(getComputedStyle(el).opacity) < 0.99 && !el.closest(".is-resolved,.is-retired")).length,
      moved: els.filter((el) => !/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(el).transform)).length,
    };
  }, selector);
  expect(state.count).toBeGreaterThan(0);
  expect({ running: state.running, faded: state.faded, moved: state.moved }).toEqual({ running: 0, faded: 0, moved: 0 });
}


async function seedBoard(page, { rows = [["Alpha", "now"], ["Beta", "now"], ["Gamma", "later"]], extraRows = 0 } = {}) {
  await page.waitForFunction(() => {
    const docs = window.__notesDb?.client.internals.docs;
    if (!docs) return false;
    for (const [k, doc] of docs) if (k.endsWith("|ws")) for (const [id, e] of doc.getMap("pages")) if (e.get("kind") === "database" && docs.get(`${k.split("|")[0]}|p:${id}`)?.getArray("views")?.length) return true;
    return false;
  }, null, { timeout: 10000 });
  return page.evaluate(({ rows, extraRows }) => {
    const d = window.__notesDb;
    const docs = d.client.internals.docs;
    let found = null;
    for (const [k, tree] of docs) {
      if (!k.endsWith("|ws")) continue;
      const ws = k.split("|")[0];
      tree.getMap("pages").forEach((e, id) => {
        if (e.get("kind") !== "database" || !docs.get(`${ws}|p:${id}`)) return;
        if (!found || e.get("createdAt") >= found.at) found = { tree, ws, id, at: e.get("createdAt") };
      });
    }
    const { tree, ws, id } = found;
    const doc = docs.get(`${ws}|p:${id}`);
    const stage = d.addProperty(doc, { type: "select", name: "Stage" });
    const now = d.addOption(doc, stage, "Now");
    const later = d.addOption(doc, stage, "For future");
    const archived = d.addProperty(doc, { type: "checkbox", name: "Archived" });
    const when = d.addProperty(doc, { type: "date", name: "When" });
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const filter = { kind: "group", id: "root", op: "and", rules: [{ kind: "rule", id: "r1", prop: archived, cond: "unchecked" }, { kind: "group", id: "g1", op: "or", rules: [{ kind: "rule", id: "r2", prop: when, cond: "is", value: { relative: "today" } }, { kind: "rule", id: "r3", prop: when, cond: "is", value: { relative: "tomorrow" } }] }] };
    d.updateView(doc, d.DEFAULT_VIEW, { type: "board", groupBy: { prop: stage }, filter });
    const schema = d.readSchema(doc);
    const stages = { now, later };
    const all = [...rows, ...Array.from({ length: extraRows }, (_, i) => [`Filler ${i + 1}`, "now"])];
    for (const [title, key] of all) d.createRow(tree, id, schema, { by: "t", title, props: { [stage]: stages[key], [when]: { start: iso } } });
    const second = d.addView(doc, "board", { name: "Second", init: { groupBy: { prop: stage } } });
    return { ws, db: id, stage, now, later, archived, when, second };
  }, { rows, extraRows });
}

const dbRows = (page, db) =>
  page.evaluate((db) => {
    const docs = window.__notesDb.client.internals.docs;
    for (const [k, tree] of docs) {
      if (!k.endsWith("|ws")) continue;
      const out = [];
      tree.getMap("pages").forEach((e, id) => {
        const j = e.toJSON();
        if (j.parent === db && !j.archivedAt && !j.deleted) out.push({ id, title: j.title, props: j.props ?? {}, order: j.order });
      });
      if (out.length) return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    }
    return [];
  }, db);

async function boardPage(page, title, kind = "inline") {
  if (kind === "inline") {
    await newPage(page, title);
    await page.keyboard.type("/Board view");
    await expect(page.locator(".n-slash-item.is-active")).toContainText("Board view");
    await page.keyboard.press("Enter");
    const root = page.locator('.n-page-column [data-testid="db-block"]');
    await expect(root.getByTestId("db-page")).toBeVisible({ timeout: 10000 });
    return root;
  }
  await newPage(page, "");
  await page.keyboard.type("/Database – Full page");
  await expect(page.locator(".n-slash-item.is-active")).toContainText("Full page");
  await page.keyboard.press("Enter");
  const root = page.locator(".n-database-host");
  await expect(root.getByTestId("db-page")).toBeVisible({ timeout: 10000 });
  return root;
}

const patchView = (page, ids, patch) =>
  page.evaluate(([ids, patch]) => {
    const d = window.__notesDb;
    d.updateView(d.client.internals.docs.get(`${ids.ws}|p:${ids.db}`), d.DEFAULT_VIEW, patch);
  }, [ids, patch]);

const column = (root, group) => root.locator(`[data-testid=db-board-column][data-group="${group}"]`);

async function mouseDrag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}

const scenarios = {
  async createPage(page) {
    await newPage(page, "Hello Notes");
    await page.keyboard.type("First line of text");
    await expect(page.getByTestId("tree-row").filter({ hasText: "Hello Notes" })).toBeVisible();
    await expect(page).toHaveURL(/\/Hello-Notes-[0-9a-f]{12}$/);
    await expect(page).toHaveTitle(/Hello Notes/);
    await expect(editor(page)).toContainText("First line of text");
  },

  async markdownShortcuts(page) {
    await newPage(page, "Shortcuts");
    const lines = [
      ["# ", "Big", "heading"],
      ["## ", "Medium", "heading"],
      ["### ", "Small", "heading"],
      ["- ", "dash", "bulletListItem"],
      ["* ", "star", "bulletListItem"],
      ["1. ", "one", "numberedListItem"],
      ["[] ", "task", "checkListItem"],
      ["> ", "fold", "toggleListItem"],
      ['" ', "said", "quote"],
    ];
    for (const [prefix, text] of lines) {
      await page.keyboard.type(prefix);
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      await toParagraph(page);
    }
    for (const [, text, type] of lines) await expect(blocks(page, type).filter({ hasText: text })).toHaveCount(1);
    await expect(page.locator('.n-page-column [data-content-type="heading"]:not([data-level])')).toHaveCount(1);
    await expect(page.locator('.n-page-column [data-content-type="heading"][data-level="2"]')).toHaveCount(1);
    await expect(page.locator('.n-page-column [data-content-type="heading"][data-level="3"]')).toHaveCount(1);
    await page.keyboard.type("---");
    await expect(blocks(page, "divider")).toHaveCount(1);
    await page.keyboard.type("```");
    await page.keyboard.press("Space");
    await expect(blocks(page, "codeBlock")).toHaveCount(1);
    await page.keyboard.type("let x = 1");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("**bold** *it* `mono` ~gone~ $x^2$ ");
    await expect(editor(page).locator("strong").filter({ hasText: "bold" })).toHaveCount(1);
    await expect(editor(page).locator("em").filter({ hasText: "it" })).toHaveCount(1);
    await expect(editor(page).locator("code").filter({ hasText: "mono" })).toHaveCount(1);
    await expect(editor(page).locator("s, del").filter({ hasText: "gone" })).toHaveCount(1);
    await expect(editor(page).locator(".katex")).toHaveCount(1);
  },

  async slashMenu(page) {
    await newPage(page, "Slash");
    const items = [
      ["Heading 1", "heading"],
      ["To-do list", "checkListItem"],
      ["Bulleted list", "bulletListItem"],
      ["Numbered list", "numberedListItem"],
      ["Toggle list", "toggleListItem"],
      ["Quote", "quote"],
      ["Callout", "callout"],
      ["Divider", "divider"],
      ["Code", "codeBlock"],
      ["Table of contents", "toc"],
      ["Block equation", "equation"],
      ["Breadcrumb", "breadcrumb"],
      ["Web bookmark", "bookmark"],
      ["Embed", "embed"],
      ["Image", "image"],
      ["Video", "video"],
      ["Audio", "audio"],
      ["File", "file"],
      ["Table", "table"],
      ["Link to page", "linkToPage"],
      ["Toggle heading 2", "heading"],
      ["3 columns", "column"],
    ];
    for (const [title, type] of items) {
      const before = await blocks(page, type).count();
      await page.keyboard.type(`/${title}`);
      await expect(page.getByTestId("slash-menu")).toBeVisible();
      await expect(page.locator(".n-slash-item.is-active")).toContainText(title);
      await page.keyboard.press("Enter");
      await expect(blocks(page, type)).not.toHaveCount(before, { timeout: 4000 });
      await page.waitForTimeout(150);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
    }
    await page.screenshot({ path: `${shots}/${page.tag}-slash-blocks.png`, fullPage: false });
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await page.screenshot({ path: `${shots}/${page.tag}-slash-menu.png` });
    await page.keyboard.press("Escape");
  },

  async blockDrag(page) {
    await newPage(page, "Reorder");
    for (const word of ["alpha", "beta", "gamma"]) {
      await page.keyboard.type(word);
      await page.keyboard.press("Enter");
    }
    const texts = async () => (await page.locator(".n-page-column .bn-editor .bn-block-content[data-content-type=paragraph]").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(await texts()).toEqual(["alpha", "beta", "gamma"]);
    const gamma = page.locator(".n-page-column .bn-block-content").filter({ hasText: "gamma" });
    const alpha = page.locator(".n-page-column .bn-block-content").filter({ hasText: "alpha" });
    await gamma.hover();
    const handle = page.getByTestId("drag-handle");
    await expect(handle).toBeVisible();
    if (page.tag === "webkit") {
      await gamma.click();
      for (let i = 0; i < 2; i++) await page.keyboard.press(`${mod}+Shift+ArrowUp`);
      await expect.poll(texts).toEqual(["gamma", "alpha", "beta"]);
      await page.locator(".n-page-column .bn-block-content").filter({ hasText: "beta" }).click();
      await page.keyboard.press(`${mod}+Shift+ArrowUp`);
      await expect.poll(texts).toEqual(["gamma", "beta", "alpha"]);
      return;
    }
    const box = await alpha.boundingBox();
    const from = await handle.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 12, { steps: 6 });
    await page.mouse.move(box.x + 60, box.y - 1, { steps: 6 });
    await page.mouse.up();
    await expect.poll(texts).toEqual(["gamma", "alpha", "beta"]);
    await page.locator(".n-page-column .bn-block-content").filter({ hasText: "beta" }).click();
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    await expect.poll(texts).toEqual(["gamma", "beta", "alpha"]);
    await page.keyboard.press(`${mod}+d`);
    await expect.poll(texts).toEqual(["gamma", "beta", "beta", "alpha"]);
  },

  async blockDragHalves(page) {
    await newPage(page, "Halves");
    for (const word of ["alpha", "beta", "gamma"]) {
      await page.keyboard.type(word);
      await page.keyboard.press("Enter");
    }
    const texts = async () => (await page.locator(".n-page-column .bn-editor .bn-block-content[data-content-type=paragraph]").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    if (page.tag === "webkit") return;
    const drag = async (word, onto, half) => {
      const source = page.locator(".n-page-column .bn-block-content").filter({ hasText: word });
      const target = page.locator(".n-page-column .bn-block-content").filter({ hasText: onto });
      await source.hover();
      const handle = page.getByTestId("drag-handle");
      let last = "";
      await expect
        .poll(async () => {
          const [g, s] = [await handle.boundingBox(), await source.boundingBox()];
          const key = g ? `${Math.round(g.x)},${Math.round(g.y)}` : "";
          const settled = !!g && !!s && key === last && g.y < s.y + s.height && g.y + g.height > s.y;
          last = key;
          return settled;
        })
        .toBe(true);
      const grip = await handle.boundingBox();
      const box = await target.boundingBox();
      const y = half === "top" ? box.y + 4 : box.y + box.height - 4;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 36, box.y + box.height / 2, { steps: 6 });
      await page.mouse.move(box.x + 36, y, { steps: 6 });
      await expect(page.locator(".n-line-drop")).toHaveCount(1);
      await page.mouse.up();
      await expect(page.locator(".n-line-drop")).toHaveCount(0);
    };
    await drag("gamma", "alpha", "top");
    await expect.poll(texts).toEqual(["gamma", "alpha", "beta"]);
    await drag("gamma", "beta", "bottom");
    await expect.poll(texts).toEqual(["alpha", "beta", "gamma"]);
  },

  async columnsDrag(page) {
    await newPage(page, "Columns");
    for (const word of ["left side", "right side"]) {
      await page.keyboard.type(word);
      await page.keyboard.press("Enter");
    }
    await page.locator(".n-page-column .bn-block-content").filter({ hasText: "left side" }).click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("page-title")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(editor(page)).toBeFocused();
    if (page.tag === "webkit") return;
    const right = page.locator(".n-page-column .bn-block-content").filter({ hasText: "right side" });
    const left = page.locator(".n-page-column .bn-block-content").filter({ hasText: "left side" });
    await right.hover();
    const from = await page.getByTestId("drag-handle").boundingBox();
    const box = await left.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 60, box.y + 10, { steps: 6 });
    await page.mouse.move(box.x + box.width - 20, box.y + 12, { steps: 6 });
    await expect(page.locator(".n-column-drop")).toHaveCount(1);
    await page.mouse.up();
    await expect(page.locator('.n-page-column [data-node-type="column"]')).toHaveCount(2);
    await expect(page.locator('.n-page-column [data-node-type="column"]').nth(1)).toContainText("right side");
    await page.screenshot({ path: `${shots}/${page.tag}-columns.png` });
  },

  async sidebarNesting(page) {
    await newPage(page, "Parent page");
    await newPage(page, "Child page");
    const child = page.getByTestId("tree-row").filter({ hasText: "Child page" });
    const parent = page.getByTestId("tree-row").filter({ hasText: "Parent page" });
    await child.dragTo(parent);
    await expect(page.getByTestId("breadcrumbs")).toContainText("Parent page");
    const childBox = await page.getByTestId("tree-row").filter({ hasText: "Child page" }).boundingBox();
    const parentBox = await parent.boundingBox();
    expect(childBox.y).toBeGreaterThan(parentBox.y);
    const pad = async (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(await pad(page.getByTestId("tree-row").filter({ hasText: "Child page" }))).toBeGreaterThan(await pad(parent));
  },

  async renameDuplicateDeleteRestore(page) {
    const row = page.getByTestId("tree-row").filter({ hasText: "Reading List" });
    await row.hover();
    await row.getByTestId("tree-more").click();
    await page.getByTestId("menu-rename").click();
    await page.getByTestId("rename-input").fill("Books to read");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tree-row").filter({ hasText: "Books to read" })).toBeVisible();
    const renamed = page.getByTestId("tree-row").filter({ hasText: "Books to read" });
    await renamed.hover();
    await renamed.getByTestId("tree-more").click();
    await page.getByTestId("menu-duplicate").click();
    await expect(page.getByTestId("tree-row").filter({ hasText: "Books to read (1)" })).toBeVisible();
    const copy = page.getByTestId("tree-row").filter({ hasText: "Books to read (1)" });
    await copy.hover();
    await copy.getByTestId("tree-more").click();
    await page.getByTestId("menu-delete").click();
    await expect(page.getByTestId("tree-row").filter({ hasText: "Books to read (1)" })).toHaveCount(0);
    await page.getByTestId("nav-trash").click();
    const trashRow = page.getByTestId("trash-row").filter({ hasText: "Books to read (1)" });
    await expect(trashRow).toBeVisible();
    await page.screenshot({ path: `${shots}/${page.tag}-trash.png` });
    await trashRow.getByTestId("trash-restore").click();
    await expect(page.getByTestId("tree-row").filter({ hasText: "Books to read (1)" })).toBeVisible();
    await page.keyboard.press("Escape");
    const old = page.getByTestId("trash-row").filter({ hasText: "Old draft" });
    await page.getByTestId("nav-trash").click();
    await old.click();
    await expect(page.getByTestId("trash-banner")).toBeVisible();
    await page.screenshot({ path: `${shots}/${page.tag}-trash-banner.png` });
    await page.getByTestId("banner-delete").click();
    await expect(page.getByTestId("home")).toBeVisible();
    await page.getByTestId("nav-trash").click();
    await expect(page.getByTestId("trash-row").filter({ hasText: "Old draft" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  },

  async iconAndCover(page) {
    await newPage(page, "Decorated");
    await page.getByTestId("page-title").hover();
    await page.getByTestId("add-icon").click();
    await expect(page.getByTestId("page-icon")).toBeVisible();
    await page.getByTestId("page-icon").click();
    await expect(page.getByTestId("emoji-picker")).toBeVisible();
    await page.getByLabel("Filter emoji").fill("rocket");
    await page.locator(".n-emoji-cell").first().click();
    await expect(page.getByTestId("page-icon")).toContainText("🚀");
    await expect(page.getByTestId("tree-row").filter({ hasText: "Decorated" })).toContainText("🚀");
    await page.getByTestId("page-title").hover();
    await page.getByTestId("add-cover").click();
    await expect(page.getByTestId("cover")).toBeVisible();
    await page.getByTestId("cover").hover();
    await page.getByTestId("cover-change").click();
    await page.getByTestId("cover-option").nth(4).click();
    await expect(page.getByTestId("cover")).toHaveAttribute("style", /linear-gradient/);
    await page.screenshot({ path: `${shots}/${page.tag}-icon-cover.png` });
    await page.getByTestId("cover").hover();
    await page.getByTestId("cover-change").click();
    await page.getByTestId("cover-remove").click();
    await expect(page.getByTestId("cover")).toHaveCount(0);
  },

  async comments(page) {
    await newPage(page, "Discussed");
    await page.keyboard.type("This sentence deserves a comment");
    await page.keyboard.press("Shift+Home");
    await expect(page.getByTestId("formatting-toolbar")).toBeVisible();
    await page.getByTestId("tb-comment").click();
    await expect(page.getByTestId("comment-composer")).toBeVisible();
    await page.keyboard.type("Love this line");
    await page.keyboard.press("Enter");
    await expect(editor(page).locator(".bn-thread-mark")).toHaveCount(1);
    await page.getByTestId("comments-toggle").click();
    const panel = page.getByTestId("comments-panel");
    await expect(panel.getByTestId("comment")).toContainText("Love this line");
    await panel.getByPlaceholder("Reply…").fill("Agreed");
    await panel.getByPlaceholder("Reply…").press("Enter");
    await expect(panel.getByTestId("comment")).toHaveCount(2);
    await page.screenshot({ path: `${shots}/${page.tag}-comments.png` });
    await panel.getByTestId("thread-resolve").click();
    await expect(panel.getByTestId("comment-thread")).toHaveCount(0);
    await panel.getByRole("button", { name: "Resolved" }).click();
    await expect(panel.getByTestId("comment-thread")).toHaveCount(1);
    await page.getByTestId("page-title").hover();
    await page.getByTestId("add-comment").click();
    await page.keyboard.type("A page-level note");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("page-comments")).toContainText("A page-level note");
  },

  async searchModal(page) {
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByTestId("search-modal")).toBeVisible();
    await page.getByTestId("search-input").fill("passport");
    await expect(page.getByTestId("search-result").first()).toContainText("Packing List");
    await page.screenshot({ path: `${shots}/${page.tag}-search.png` });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("page-title")).toHaveText("Packing List");
    await expect(page.getByTestId("breadcrumbs")).toContainText("Trip to Lisbon");
    await page.getByTestId("nav-search").click();
    await expect(page.getByTestId("search-result").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("search-modal")).toHaveCount(0);
  },

  async routing(page) {
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await expect(page.getByTestId("page-title")).toHaveText("Meeting Notes");
    await page.getByTestId("tree-row").filter({ hasText: "Trip to Lisbon" }).click();
    await expect(page.getByTestId("page-title")).toHaveText("Trip to Lisbon");
    await page.goBack();
    await expect(page.getByTestId("page-title")).toHaveText("Meeting Notes");
    await page.goForward();
    await expect(page.getByTestId("page-title")).toHaveText("Trip to Lisbon");
    await page.locator(".n-pageblock").filter({ hasText: "Packing List" }).click();
    await expect(page.getByTestId("page-title")).toHaveText("Packing List");
    await page.goto(page.url().replace(/\/[^/]*$/, "/Nothing-000000000000"));
    await expect(page.getByTestId("not-found")).toBeVisible();
    await page.goto(page.url().replace(/\/[^/]*$/, "/trash"));
    await expect(page.getByTestId("trash")).toBeVisible();
    await page.goto(page.url().replace(/\/[^/]*$/, "/settings"));
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.goto(page.url().replace(/\/[^/]*$/, "/search?q=agenda"));
    await expect(page.getByTestId("search-result").first()).toContainText("Meeting Notes");
  },

  async blockAnchor(page) {
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    const target = page.locator(".n-page-column .bn-block-outer").filter({ hasText: "Book the next meeting" }).first();
    const id = await target.getAttribute("data-id");
    const url = page.url().split("?")[0];
    await page.goto(`${url}?block=${id}`);
    await expect(page.locator(`.n-flash-overlay[data-target="${id}"]`)).toHaveCount(1, { timeout: 5000 });
  },

  async versionHistory(page) {
    await newPage(page, "Versioned");
    await page.keyboard.type("original words");
    await page.waitForTimeout(1600);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("replacement words");
    await page.waitForTimeout(1600);
    await expect(editor(page)).not.toContainText("original words");
    await page.getByTestId("history-button").click();
    await expect(page.getByTestId("history")).toBeVisible();
    const rows = page.getByTestId("history-row");
    await expect(rows.nth(1)).toBeVisible();
    const count = await rows.count();
    let found = false;
    for (let i = 1; i < count && !found; i++) {
      await rows.nth(i).click();
      await page.waitForTimeout(300);
      found = (await page.locator(".n-history-preview").innerText()).includes("original words");
    }
    expect(found).toBe(true);
    await page.screenshot({ path: `${shots}/${page.tag}-history.png` });
    await page.getByTestId("history-restore").click();
    await expect(editor(page)).toContainText("original words");
    await page.waitForTimeout(1600);
    await page.getByTestId("history-button").click();
    await expect(rows.first()).toContainText("Current version");
    await expect(page.getByTestId("history-restore")).toBeDisabled();
    let undo = false;
    const again = await rows.count();
    for (let i = 1; i < again && !undo; i++) {
      await rows.nth(i).click();
      await page.waitForTimeout(300);
      undo = (await page.locator(".n-history-preview").innerText()).includes("replacement words");
    }
    expect(undo).toBe(true);
    await expect(page.getByTestId("history-restore")).toBeEnabled();
    await page.getByTestId("history-restore").click();
    await expect(editor(page)).toContainText("replacement words");
  },

  async highFrequencyMotionIsShort(page) {
    const longest = (selector) =>
      page.evaluate((sel) => {
        const els = [...document.querySelectorAll(sel)];
        const all = els.flatMap((el) => el.getAnimations());
        return Math.max(0, ...all.filter((a) => a.transitionProperty !== "caret-color").map((a) => { const t = a.effect.getTiming(); return (Number(t.duration) || 0) + (Number(t.delay) || 0); }));
      }, selector);
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    expect(await longest(".n-main-col .n-page")).toBeLessThanOrEqual(160);
    await newPage(page, "Moves");
    for (const word of ["first", "second"]) {
      await page.keyboard.type(word);
      await page.keyboard.press("Enter");
    }
    await page.locator(".n-page-column .bn-block-content").filter({ hasText: "second" }).click();
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    await page.waitForTimeout(30);
    expect(await longest(".n-page-column .bn-block-outer")).toBeLessThanOrEqual(160);
  },

  async reducedMotionCrossfades(page) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
      await page.getByTestId("page-more").click();
      const menu = page.locator(".n-popover").filter({ has: page.getByTestId("page-more-menu") }).first();
      await menu.waitFor();
      const opening = await menu.evaluate((el) => el.getAnimations().map((a) => a.effect.getKeyframes().map((k) => [k.opacity, getComputedStyle(el).transform])));
      expect(opening.length).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      expect(await page.locator(".n-ghost").count()).toBe(0);
      const moving = await page.evaluate(() =>
        document.getAnimations().filter((a) => a.effect.getKeyframes().some((k) => k.transform && !/^(none|translate\(0px(, 0px)?\)( scale\(1\))?|translateY\(0px\)( scale\(1\))?|matrix\(1, 0, 0, 1, 0, 0\))$/.test(k.transform))).length,
      );
      expect(moving).toBe(0);
    } finally {
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  },

  async noPageGhostWhileEditing(page) {
    await newPage(page, "Ghostless");
    await page.keyboard.type("body text");
    await page.evaluate(() => {
      window.__pageGhosts = 0;
      new MutationObserver((list) => {
        for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.classList.contains("is-page-leaving")) window.__pageGhosts++;
      }).observe(document.body, { childList: true });
    });
    await page.getByTestId("page-title").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" renamed", { delay: 40 });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__pageGhosts)).toBe(0);
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await expect.poll(() => page.evaluate(() => window.__pageGhosts)).toBe(1);
  },

  async canonicalSlug(page) {
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/Meeting-Notes-[0-9a-f]{12}$/);
    const id = new URL(page.url()).pathname.slice(-12);
    await page.evaluate((pageId) => window.notesClient.navigate(`/stale-name-${pageId}`), id);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 3000 }).toBe(`/Meeting-Notes-${id}`);
  },

  async exportMarkdown(page) {
    await newPage(page, "Exported");
    await page.keyboard.type("# Section");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- point");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("see @Meeting");
    await expect(page.getByRole("option").filter({ hasText: "Meeting Notes" }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await page.getByTestId("page-more").click();
    await page.screenshot({ path: `${shots}/${page.tag}-page-menu.png` });
    await page.getByTestId("menu-export").hover();
    const download = page.waitForEvent("download");
    await page.getByTestId("menu-export-md").click();
    const file = await download;
    const text = readFileSync(await file.path(), "utf8");
    expect(text).toContain("# Exported");
    expect(text).toContain("# Section");
    expect(text).toContain("point");
    expect(text).toContain("see Meeting Notes");
    expect(text).not.toMatch(/@[0-9a-f]{12}/);
  },

  async pageStyle(page) {
    await page.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await page.getByTestId("page-more").click();
    await page.getByTestId("font-serif").click();
    await page.getByTestId("menu-full-width").click();
    await page.getByTestId("menu-small-text").click();
    await page.getByTestId("menu-lock").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page")).toHaveClass(/font-serif/);
    await expect(page.getByTestId("page")).toHaveClass(/is-full/);
    await expect(page.getByTestId("page")).toHaveClass(/is-small/);
    await expect(page.getByTestId("lock-badge")).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await page.getByTestId("lock-badge").click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await page.getByTestId("favorite-button").click();
    await expect(page.getByTestId("section-favorites")).toContainText("Meeting Notes");
  },

  async templates(page) {
    await page.getByTestId("nav-templates").click();
    await page.getByTestId("template-section-yours").click();
    await page.getByTestId("template-own-card").filter({ hasText: "Weekly Review" }).click();
    await expect(page.getByTestId("template-preview")).toBeVisible();
    await page.getByTestId("template-add-to").click();
    await page.getByTestId("menu-template-target-top").click();
    await page.getByTestId("template-use").click();
    await expect(page.getByTestId("page-title")).toHaveText("Weekly Review");
    await expect(editor(page)).toContainText("Lessons");
    await newPage(page, "Empty start");
    await page.getByTestId("page-title").click();
    await expect(page.getByTestId("empty-starter")).toHaveCount(0);
  },

  async staleMenuRetired(page) {
    await newPage(page, "Stale menus");
    await page.evaluate(() => {
      const stale = document.createElement("div");
      stale.className = "n-popover n-slash n-inline-menu";
      stale.setAttribute("role", "listbox");
      stale.setAttribute("data-testid", "inline-menu");
      stale.id = "stale-menu";
      stale.textContent = "Link to page Meeting";
      document.body.appendChild(stale);
    });
    await page.keyboard.type("[[Trip");
    await expect(page.getByTestId("inline-menu")).toHaveCount(1);
    await expect(page.getByTestId("inline-menu")).toContainText("Trip to Lisbon");
    const stale = await page.evaluate(() => {
      const el = document.getElementById("stale-menu");
      return { inert: el?.hasAttribute("inert"), hidden: el?.getAttribute("aria-hidden"), role: el?.getAttribute("role"), opacity: el ? getComputedStyle(el).opacity : null };
    });
    expect(stale).toEqual({ inert: true, hidden: "true", role: null, opacity: stale.opacity });
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.getElementById("stale-menu")?.remove());
  },

  async microMotionTree(page) {
    await recordMotion(page);
    await page.getByTestId("sidebar-new-page").click();
    await expect(page.getByTestId("page-title")).toBeFocused();
    await page.keyboard.type("Fresh row");
    await expect(page.getByTestId("tree-row").filter({ hasText: "Fresh row" })).toBeVisible();
    expect(await animatedSince(page, "tree-row")).toBeGreaterThan(0);
    await settled(page, '[data-testid="tree-row"]');
    const row = page.getByTestId("tree-row").filter({ hasText: "Fresh row" });
    await recordMotion(page);
    await row.hover();
    await row.getByTestId("tree-more").click();
    await page.getByTestId("menu-delete").click();
    await page.waitForSelector(".n-ghost.is-row-leaving", { state: "attached", timeout: 2000 });
    await expect(page.getByTestId("tree-row").filter({ hasText: "Fresh row" })).toHaveCount(0);
    await page.getByTestId("nav-trash").click();
    await recordMotion(page);
    await page.getByTestId("trash-row").filter({ hasText: "Fresh row" }).getByTestId("trash-restore").click();
    await page.waitForSelector(".n-ghost.is-row-leaving", { state: "attached", timeout: 2000 });
    await expect(page.getByTestId("tree-row").filter({ hasText: "Fresh row" })).toBeVisible();
    expect(await animatedSince(page, "tree-row")).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    for (let i = 0; i < 4; i++) await page.getByTestId("sidebar-new-page").click();
    await settled(page, '[data-testid="tree-row"]');
    await expect(page.locator(".n-ghost")).toHaveCount(0, { timeout: 2000 });
    expect(await page.locator('[data-testid="tree-row"][inert], [data-testid="tree-row"] [inert]').count()).toBe(0);
  },

  async microMotionMenus(page) {
    await newPage(page, "Menus move");
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    expect(await page.getByTestId("slash-menu").evaluate((el) => getComputedStyle(el).animationName)).toBe("m-menu-in");
    await recordMotion(page);
    await page.keyboard.type("hea");
    await expect(page.getByTestId("slash-h1")).toBeVisible();
    expect(await animatedSince(page, "flip")).toBeGreaterThan(0);
    await settled(page, '[data-testid="slash-menu"] [data-flip]');
    await page.keyboard.press("Escape");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("/");
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(500);
    await expect(page.locator(".n-ghost")).toHaveCount(0, { timeout: 2000 });
    expect(await page.locator(".n-slash:not(.is-retired)").count()).toBeLessThanOrEqual(1);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await toParagraph(page);
    await recordMotion(page);
    await page.keyboard.type("# Typed heading");
    await expect(blocks(page, "heading").filter({ hasText: "Typed heading" })).toHaveCount(1);
    expect(await animatedSince(page, "bn-block-content")).toBeGreaterThan(0);
    await settled(page, ".n-page-column .bn-block-content");
    await page.getByTestId("page-title").click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press("Backspace");
    expect(await page.getByTestId("page-title").evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe("m-fade-in");
    await page.keyboard.type("Menus move");
  },

  async microMotionSearch(page) {
    await page.getByTestId("page-title").click();
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByTestId("search-modal")).toBeVisible();
    await recordMotion(page);
    await page.keyboard.type("Lisbon");
    await expect(page.getByTestId("search-result").filter({ hasText: "Trip to Lisbon" })).toBeVisible();
    expect(await animatedSince(page, "flip")).toBeGreaterThan(0);
    await settled(page, '[data-testid="search-result"]');
    await page.keyboard.press("Escape");
    await expect(page.locator(".n-ghost")).toHaveCount(0, { timeout: 2000 });
  },

  async mentions(page) {
    await newPage(page, "Linking");
    await page.keyboard.type("See @meeting");
    await expect(page.getByTestId("inline-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(editor(page).locator(".n-mention.is-page")).toContainText("Meeting Notes");
    await page.keyboard.type("and [[Trip");
    await expect(page.getByTestId("inline-menu")).toContainText("Trip to Lisbon");
    await page.keyboard.press("Enter");
    await expect(editor(page).locator(".n-mention.is-page")).toHaveCount(2);
    await page.keyboard.type("on @today");
    await page.keyboard.press("Enter");
    await expect(editor(page).locator(".n-mention.is-date")).toContainText("Today");
    await editor(page).locator(".n-mention.is-page").filter({ hasText: "Meeting Notes" }).click();
    await expect(page.getByTestId("page-title")).toHaveText("Meeting Notes");
    await expect(page.getByTestId("backlinks")).toContainText("backlink");
  },

  async mediaUpload(page) {
    await newPage(page, "Media");
    await page.keyboard.type("/Image");
    await page.keyboard.press("Enter");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAI0lEQVR4nGP4z8DwnxLMMGrAqAGjBowaMGrAqAGjBgwPAwBlEP+B3Mh3dQAAAABJRU5ErkJggg==", "base64");
    await page.locator(".n-page-column .bn-add-file-button").first().click();
    await expect(page.getByTestId("file-panel")).toBeVisible();
    await page.getByTestId("file-input").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".n-page-column img.bn-visual-media, .n-page-column [data-content-type=image] img")).toHaveAttribute("src", /^blob:/, { timeout: 8000 });
  },

  async codeLanguage(page) {
    await newPage(page, "Code");
    await page.keyboard.type("```");
    await page.keyboard.press("Space");
    await expect(page.locator(".n-code")).toBeVisible();
    await page.waitForTimeout(150);
    await page.keyboard.type("const answer = 42;");
    await expect(page.locator(".n-code-pre")).toContainText("const answer = 42;");
    await page.locator(".n-code").hover();
    await page.locator(".n-code-lang").click();
    await page.getByPlaceholder("Search for a language…").fill("type");
    await page.keyboard.press("Enter");
    await expect(page.locator(".n-code")).toHaveAttribute("data-language", "typescript");
    await expect(page.locator(".n-code-pre span[style*='--shiki']").first()).toBeVisible({ timeout: 8000 });
    await page.locator(".n-code-lang").click();
    await page.getByPlaceholder("Search for a language…").fill("mermaid");
    await page.keyboard.press("Enter");
    await page.locator(".n-code-pre code").click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("graph TD\nA-->B");
    await expect(page.locator(".n-mermaid svg")).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${shots}/${page.tag}-code-mermaid.png` });
  },

  async keyboardBlocks(page) {
    await newPage(page, "Keys");
    await page.keyboard.type("turn me");
    await page.keyboard.press(`${mod}+Alt+1`);
    await expect(blocks(page, "heading").filter({ hasText: "turn me" })).toHaveCount(1);
    await page.keyboard.press(`${mod}+Alt+4`);
    await expect(blocks(page, "checkListItem").filter({ hasText: "turn me" })).toHaveCount(1);
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.locator('.n-page-column [data-content-type="checkListItem"][data-checked="true"]')).toHaveCount(1);
    await page.keyboard.press(`${mod}+Alt+0`);
    await expect(blocks(page, "paragraph").filter({ hasText: "turn me" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".n-page-column .ProseMirror-selectednode")).toHaveCount(1);
    await page.keyboard.press(`${mod}+d`);
    await expect(blocks(page, "paragraph").filter({ hasText: "turn me" })).toHaveCount(2);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const first = blocks(page, "paragraph").filter({ hasText: "turn me" }).first();
    const r = await first.boundingBox();
    const tail = await page.locator(".n-page-tail").boundingBox();
    await page.mouse.move(r.x - 60, tail.y + 30);
    await page.mouse.down();
    await page.mouse.move(r.x - 40, r.y + 5, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press("Backspace");
    await expect(blocks(page, "paragraph").filter({ hasText: "turn me" })).toHaveCount(0);
  },

  async selectAllBlocks(page) {
    await newPage(page, "Pick");
    await page.keyboard.type("hi");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("nice to meet you");
    await page.keyboard.press("Enter");
    await page.keyboard.type("wow");
    const picked = page.locator(".n-page-column .bn-block-content.n-block-picked");
    await page.keyboard.press(`${mod}+a`);
    await expect(picked).toHaveCount(0);
    await page.keyboard.press(`${mod}+a`);
    await expect(picked).toHaveCount(4);
    await expect(page.locator(".n-page-column .n-range-picked")).toHaveCount(1);
    const tint = await picked.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tint).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(shots, `selectAllBlocks-${page.context().browser().browserType().name()}.png`) });
    await page.keyboard.press("ArrowDown");
    await expect(picked).toHaveCount(0);
  },

  async partialBlockDrag(page) {
    await newPage(page, "Drag");
    await page.keyboard.type("alpha beta gamma");
    await page.keyboard.press("Enter");
    await page.keyboard.type("delta epsilon zeta");
    const first = await blocks(page, "paragraph").filter({ hasText: "alpha beta gamma" }).locator(".bn-inline-content").boundingBox();
    const second = await blocks(page, "paragraph").filter({ hasText: "delta epsilon zeta" }).locator(".bn-inline-content").boundingBox();
    await page.mouse.move(first.x + first.width * 0.4, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + second.width * 0.4, second.y + second.height / 2, { steps: 8 });
    await page.mouse.up();
    const selected = await page.evaluate(() => String(window.getSelection()));
    expect(selected).toContain("gamma");
    expect(selected).toContain("delta");
    expect(selected).not.toContain("alpha");
    await expect(page.locator(".n-page-column .bn-block-content.n-block-picked")).toHaveCount(0);
    await expect(page.locator(".n-page-column .n-range-picked")).toHaveCount(0);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+a`);
    await expect(page.locator(".n-page-column .bn-block-content.n-block-picked")).toHaveCount(2);
  },

  async workspaceSwitch(page) {
    const rows = page.getByTestId("tree-row");
    const tree = page.getByTestId("workspace-tree");
    await expect(page.getByTestId("section-private")).toBeVisible();
    await expect(rows.filter({ hasText: "Getting Started" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Roadmap" })).toHaveCount(0);
    const personal = await tree.getAttribute("data-workspace");
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-item").filter({ hasText: "Ardia Team" }).click();
    await expect(page.getByTestId("workspace-switcher")).toContainText("Ardia Team");
    await expect(tree).not.toHaveAttribute("data-workspace", personal);
    await expect(tree).toHaveClass(/is-entering/);
    expect(await page.evaluate(() => document.querySelectorAll(".n-ghost.is-ws-leaving").length)).toBeLessThanOrEqual(1);
    await expect(rows.filter({ hasText: "Roadmap" })).toBeVisible();
    await expect(rows.filter({ hasText: "Getting Started" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll(".n-ghost.is-ws-leaving").length), { timeout: 2000 }).toBe(0);
    await expect(tree).toHaveCSS("opacity", "1");
    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("home")).toContainText("Roadmap");
    await expect(page.locator(".n-home-card").filter({ hasText: "Getting Started" })).toHaveCount(0);
    await page.getByTestId("nav-search").click();
    await page.locator(".n-palette-input input").fill("Getting");
    await page.waitForTimeout(400);
    await expect(page.locator(".n-palette-row").filter({ hasText: "Getting Started" })).toHaveCount(0);
    await page.locator(".n-palette-input input").fill("Road");
    await expect(page.locator(".n-palette-row").filter({ hasText: "Roadmap" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("sidebar-new-page").click();
    await expect(page.locator(".n-title")).toBeVisible();
    await page.keyboard.type("Team plan");
    const team = await tree.getAttribute("data-workspace");
    await expect(page.getByTestId(`section-${team}`)).toContainText("Team plan");
    await page.reload();
    await page.waitForSelector(".bn-editor", { timeout: 30_000 });
    await expect(page.getByTestId("workspace-switcher")).toContainText("Ardia Team");
    await expect(rows.filter({ hasText: "Roadmap" })).toBeVisible();
    await page.evaluate(() => window.notesClient.navigate("/5a17a2700001"));
    await expect(page.getByTestId("workspace-switcher")).not.toContainText("Ardia Team");
    await expect(tree).toHaveAttribute("data-workspace", personal);
    await expect(rows.filter({ hasText: "Getting Started" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Roadmap" })).toHaveCount(0);
    for (let i = 0; i < 4; i++) {
      await page.getByTestId("workspace-switcher").click();
      await page.getByTestId("workspace-item").filter({ hasText: i % 2 ? "Personal" : "Ardia Team" }).click();
    }
    await expect.poll(() => page.evaluate(() => document.querySelectorAll(".n-ghost.is-ws-leaving").length), { timeout: 2000 }).toBe(0);
    await expect(page.getByTestId("workspace-tree")).toHaveCount(1);
    await expect(rows.filter({ hasText: "Getting Started" }).first()).toBeVisible();
  },

  async pageShare(page) {
    const rows = page.getByTestId("tree-row");
    const order = () => page.getByTestId("section-private").getByTestId("tree-row").evaluateAll((els) => els.filter((el) => el.style.paddingLeft === "6px").map((el) => el.textContent.trim()));
    const before = await order();
    await rows.filter({ hasText: "Trip to Lisbon" }).click();
    await page.getByTestId("share-button").click();
    const popover = page.getByTestId("share-popover");
    await expect(popover).toContainText("Only you can see this page");
    const shareTop = await page.getByTestId("share-page").boundingBox();
    const moveTop = await page.getByTestId("share-move").first().boundingBox();
    expect(moveTop.y).toBeGreaterThan(shareTop.y);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${page.tag}-page-share-private.png` });
    await page.getByTestId("share-page").click();
    await expect(page.locator(".n-toast").filter({ hasText: "Shared “Trip to Lisbon”" })).toBeVisible();
    const trip = page.getByTestId("section-private").getByTestId("tree-row").filter({ hasText: "Trip to Lisbon" });
    await expect(trip.getByTestId("tree-shared")).toBeVisible();
    expect(await order()).toEqual(before);
    const shareId = await page.evaluate(() => window.notesClient.workspaces().find((w) => w.pageShare)?.id);
    expect(shareId).toBeTruthy();
    await expect(page.getByTestId("page-title")).toHaveText("Trip to Lisbon");
    await page.getByTestId("page-title").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("shared edit");
    await expect.poll(() => page.evaluate((id) => window.__notesMock.docs.get(`${id}|p:5a17a2700005`)?.getXmlFragment("blocks").toString().includes("shared edit"), shareId)).toBe(true);
    await trip.hover();
    await trip.getByTestId("tree-chevron").click();
    await expect(page.getByTestId("section-private").getByTestId("tree-row").filter({ hasText: "Packing List" })).toBeVisible();
    await trip.hover();
    await trip.getByTestId("tree-add").click();
    await expect(page.getByTestId("page-title")).toBeFocused();
    await page.keyboard.type("Day one");
    await expect.poll(() => page.evaluate((id) => window.__notesMock.docs.get(`${id}|ws`)?.getMap("pages").size, shareId)).toBe(3);
    await expect(page.getByTestId("breadcrumbs")).toContainText("Trip to Lisbon");
    await page.getByTestId("workspace-switcher").click();
    await expect(page.getByTestId("workspace-item")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await trip.click();
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("share-title")).toHaveText("Shared page");
    await expect(page.getByTestId("share-through")).toHaveText("iCloud Drive › Ardia Shared › Trip to Lisbon");
    await expect(page.getByTestId("share-invite")).toBeVisible();
    await expect(page.getByTestId("share-move")).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${page.tag}-page-share-owner.png` });
    await page.getByTestId("share-invite").click();
    await expect.poll(() => page.evaluate(() => window.notesClient.call("counts", {}).then((c) => c.page_share_invites))).toBe(1);
    await page.getByTestId("share-button").click();
    await page.getByTestId("share-stop").click();
    await expect(page.getByTestId("share-stop-note")).toBeVisible();
    await page.getByTestId("share-stop").click();
    await expect(page.locator(".n-toast").filter({ hasText: "is private again" })).toBeVisible();
    await expect(trip.getByTestId("tree-shared")).toHaveCount(0);
    expect(await order()).toEqual(before);
    await expect(page.getByTestId("section-private").getByTestId("tree-row").filter({ hasText: "Day one" })).toBeVisible();
    await page.getByTestId("share-button").click();
    await expect(popover).toContainText("Only you can see this page");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.__notesMock.docs.get("a1b2c3d4e5f6|p:5a17a2700005")?.getXmlFragment("blocks").toString().includes("shared edit"))).toBe(true);

    await page.evaluate(() => window.__notesMock.joinAsPage("Offsite plan"));
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("ws-join").click();
    const withMe = page.getByTestId("section-shared-with-me");
    await expect(withMe.getByTestId("tree-row").filter({ hasText: "Offsite plan" })).toBeVisible();
    await expect(page.getByTestId("workspace-switcher")).toContainText("Personal");
    await withMe.getByTestId("tree-row").filter({ hasText: "Offsite plan" }).click();
    await expect(page.getByTestId("breadcrumbs")).toContainText("Shared with me");
    await expect(page.getByTestId("workspace-switcher")).toContainText("Personal");
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("share-title")).toHaveText("Shared with you");
    await expect(page.getByTestId("share-stop")).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${page.tag}-page-share-recipient.png` });
    await page.getByTestId("share-leave").click();
    await expect(withMe).toHaveCount(0);
  },

  async workspaces(page) {
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("ws-create-shared").click();
    await page.getByTestId("workspace-name").fill("Book Club");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Book Club").first()).toBeVisible();
    await page.getByTestId("workspace-switcher").click();
    await expect(page.getByTestId("workspace-item")).toHaveCount(3);
    await page.getByTestId("ws-join").click();
    await expect(page.getByTestId("workspace-switcher")).toContainText("Joined Space");
    await expect(page.getByTestId("tree-row").filter({ hasText: "Welcome to the shared space" })).toBeVisible();
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-item").filter({ hasText: "Personal" }).click();
    await page.getByTestId("tree-row").filter({ hasText: "Reading List" }).click();
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("share-popover")).toContainText("Only you can see this page");
    await page.getByTestId("share-move").filter({ hasText: "Ardia Team" }).click();
    await expect(page.getByTestId("section-f6e5d4c3b2a1")).toContainText("Reading List");
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("share-popover")).toContainText("Shared in Ardia Team");
    await page.keyboard.press("Escape");
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-item").filter({ hasText: "Personal" }).click();
    await page.getByTestId("tree-row").filter({ hasText: "Trip to Lisbon" }).click();
    await page.getByTestId("page-more").click();
    await page.getByTestId("menu-move").click();
    await page.getByTestId("move-dialog").locator("input").fill("Meeting");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("breadcrumbs")).toContainText("Meeting Notes");
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-name").fill("Ada L.");
    await page.getByTestId("settings-name").press("Enter");
    await expect(page.locator(".n-ws-name")).toBeVisible();
    await page.screenshot({ path: `${shots}/${page.tag}-settings.png` });
  },

  async emojiInline(page) {
    await newPage(page, "Emoji");
    await page.keyboard.type("Nice :tada");
    await expect(page.getByTestId("inline-menu").locator(".n-menu-item").first()).toContainText("🎉", { timeout: 8000 });
    await page.keyboard.press("Enter");
    await expect(editor(page)).toContainText("🎉");
  },

  async databases(page) {
    await newPage(page, "Project tracker");
    await page.keyboard.type("/Table view");
    await expect(page.locator(".n-slash-item.is-active")).toContainText("Table view");
    await page.keyboard.press("Enter");
    const block = page.locator('.n-page-column [data-testid="db-block"]');
    await expect(block.getByTestId("db-page")).toBeVisible({ timeout: 10000 });
    await block.getByTestId("db-new").click();
    await expect(block.getByTestId("db-row")).toHaveCount(1, { timeout: 8000 });
    await page.screenshot({ path: `${shots}/${page.tag}-db-inline.png` });
    await page.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
    await page.keyboard.type("/Linked view");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("db-link-picker")).toBeVisible({ timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.getByTestId("tree-row").filter({ hasText: "Project tracker" }).click();
    await page.keyboard.press("Escape");
    await newPage(page, "");
    await page.keyboard.type("/Database – Full page");
    await expect(page.locator(".n-slash-item.is-active")).toContainText("Full page");
    await page.keyboard.press("Enter");
    const full = page.locator('.n-database-host [data-testid="db-page"]');
    await expect(full).toBeVisible({ timeout: 10000 });
    await full.getByTestId("db-new").click();
    await expect(page).toHaveURL(/[?&]p=[0-9a-f]{12}/, { timeout: 8000 });
    const body = page.getByTestId("db-peek-body");
    await expect(body.getByTestId("row-body")).toBeVisible({ timeout: 8000 });
    await body.locator(".bn-editor").click();
    await page.keyboard.type("Notes inside the row");
    await expect(body).toContainText("Notes inside the row");
    await page.screenshot({ path: `${shots}/${page.tag}-db-peek.png` });
    const rowUrl = new URL(page.url()).searchParams.get("p");
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]p=/);
    await page.goto(page.url().replace(/\/[^/]*$/, `/Row-${rowUrl}`));
    await expect(page.locator(".n-row-props")).toBeVisible({ timeout: 8000 });
    await expect(editor(page)).toContainText("Notes inside the row");
  },

  async saveIndicator(page) {
    await page.waitForLoadState("networkidle");
    await page.goto(`${page.url().split("?")[0]}?devtools`);
    await page.waitForSelector(".n-page-column .bn-editor");
    const indicator = page.getByTestId("save-indicator");
    await newPage(page, "Saving");
    await page.keyboard.type("quick save");
    await page.waitForTimeout(600);
    await expect(indicator).toHaveAttribute("data-state", "none");
    await page.evaluate(() => window.__notesMock.setSaveDelay(1800));
    await page.keyboard.type(" slow save");
    await page.waitForTimeout(400);
    await expect(indicator).toHaveAttribute("data-state", "none");
    await expect(indicator).toHaveAttribute("data-state", "saving", { timeout: 3000 });
    await expect(indicator).toHaveText("Saving…");
    await expect(indicator).toHaveAttribute("data-state", "saved", { timeout: 4000 });
    await expect(indicator).toHaveAttribute("data-state", "none", { timeout: 4000 });
    await page.evaluate(() => window.__notesMock.setSaveDelay(200));
    await page.getByTestId("dev-save-failing").check();
    await page.locator(".n-page-column .bn-block-content").filter({ hasText: "quick save" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" offline");
    await expect(indicator).toHaveAttribute("data-state", "unsaved", { timeout: 3000 });
    await expect(indicator).toContainText("Couldn’t save — retrying");
    await expect(indicator).toHaveAttribute("title", /keeps trying/);
    await page.screenshot({ path: `${shots}/${page.tag}-save-unsaved.png` });
    await page.getByTestId("dev-save-failing").uncheck();
    await expect(indicator).toHaveAttribute("data-state", "saved", { timeout: 4000 });
    await expect(indicator).toHaveAttribute("data-state", "none", { timeout: 4000 });
    await page.getByTestId("dev-refuse").click();
    await expect(page.locator(".n-toast").filter({ hasText: "the page was deleted" })).toBeVisible();
  },

  async collaboration(_page, browser, url) {
    const a = await open(browser, url, { as: "Ada" });
    await a.page.close();
    const ctxA = a.context;
    const ctxB = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    let pageA = null;
    let pageB = null;
    await ctxA.exposeBinding("__notesMockRelay", async (_src, msg) => {
      await pageB?.evaluate((m) => window.__notesMockDeliver?.(m), msg).catch(() => {});
    });
    await ctxB.exposeBinding("__notesMockRelay", async (_src, msg) => {
      await pageA?.evaluate((m) => window.__notesMockDeliver?.(m), msg).catch(() => {});
    });
    pageA = liveLocators(await ctxA.newPage());
    await pageA.goto(`${url}/?reset&as=Ada`);
    await pageA.waitForSelector(".bn-editor");
    await pageA.getByTestId("tree-row").filter({ hasText: "Meeting Notes" }).click();
    await pageA.waitForSelector(".bn-editor");
    const path = new URL(pageA.url()).pathname;
    pageB = liveLocators(await ctxB.newPage());
    await pageB.goto(`${url}${path}?as=Grace`);
    await pageB.waitForSelector(".n-page-column .bn-editor");
    await expect(pageB.getByTestId("page-title")).toHaveText("Meeting Notes");
    await pageA.locator(".n-page-column .bn-block-content").filter({ hasText: "Send the summary" }).click();
    await pageA.keyboard.press("End");
    await pageA.keyboard.type(" — typed by Ada");
    await expect(pageB.locator(".n-page-column .bn-editor")).toContainText("typed by Ada", { timeout: 8000 });
    await pageB.locator(".n-page-column .bn-block-content").filter({ hasText: "Book the next meeting" }).click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" — and Grace");
    await expect(pageA.locator(".n-page-column .bn-editor")).toContainText("and Grace", { timeout: 8000 });
    await expect(pageA.locator(".bn-collaboration-cursor__caret").first()).toBeAttached({ timeout: 8000 });
    await pageA.locator(".n-page-column .bn-block-content").filter({ hasText: "and Grace" }).click();
    await pageA.keyboard.press("End");
    await pageA.keyboard.press("Enter");
    await pageA.keyboard.type("/Table view");
    await pageA.keyboard.press("Enter");
    await expect(pageA.locator('.n-page-column [data-testid="db-block"] [data-testid="db-page"]')).toBeVisible({ timeout: 10000 });
    await pageA.locator('.n-page-column [data-testid="db-block"]').getByTestId("db-new").click();
    await expect(pageB.locator('.n-page-column [data-testid="db-block"] [data-testid="db-row"]')).toHaveCount(1, { timeout: 10000 });
    if (await pageA.getByTestId("db-peek-close").count()) await pageA.getByTestId("db-peek-close").click();
    await expect(pageA.getByTestId("db-peek-layer")).toHaveCount(0);
    await expect(pageA.getByTestId("presence-avatar").first()).toBeVisible({ timeout: 10000 });
    await expect(pageA.getByTestId("presence-avatar").first()).toHaveAttribute("title", /Grace/);
    await pageA.getByTestId("page-title").click();
    await pageA.keyboard.press("End");
    await pageA.keyboard.type(" (shared)");
    await expect(pageB.getByTestId("page-title")).toHaveText("Meeting Notes (shared)", { timeout: 8000 });
    await pageA.screenshot({ path: `${shots}/${_page.tag}-collab-a.png` });
    await pageB.screenshot({ path: `${shots}/${_page.tag}-collab-b.png` });
    await ctxA.close();
    await ctxB.close();
  },

  async inlineDatabaseNew(page) {
    for (const kind of ["inline", "full"]) {
      const root = await boardPage(page, "Plan board", kind);
      const ids = await seedBoard(page);
      await expect(root.locator("[data-testid=db-card]")).toHaveCount(3);
      const lane = column(root, ids.later);
      await expect(lane.locator("[data-testid=db-card]")).toHaveCount(1);
      const button = await lane.getByTestId("db-board-new").boundingBox();
      await page.mouse.click(button.x + 24, button.y + button.height / 2);
      await expect(lane.getByTestId("db-card-title-input")).toBeFocused();
      await expect(lane.locator("[data-testid=db-card]")).toHaveCount(2);
      await page.keyboard.type("Fresh idea");
      await page.keyboard.press("Enter");
      await expect(lane.locator("[data-testid=db-card]").filter({ hasText: "Fresh idea" })).toHaveCount(1);
      const fresh = (await dbRows(page, ids.db)).find((r) => r.title === "Fresh idea");
      expect(fresh.props[ids.stage]).toBe(ids.later);
      expect(fresh.props[ids.when]?.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fresh.props[ids.archived] ?? false).toBe(false);
      await expect(page.locator(".ProseMirror-selectednode")).toHaveCount(0);
      if (kind === "inline") await page.getByTestId("tree-row").filter({ hasText: "Plan board" }).click();
    }
  },

  async inlineDatabaseDrag(page) {
    const root = await boardPage(page, "Drag board");
    const ids = await seedBoard(page, { extraRows: 9 });
    const now = column(root, ids.now);
    const later = column(root, ids.later);
    await expect(now.locator("[data-testid=db-card]")).toHaveCount(11);
    const last = now.locator("[data-testid=db-card]").last();
    await last.scrollIntoViewIfNeeded();
    const from = await last.boundingBox();
    const target = await later.boundingBox();
    expect(from.y).toBeGreaterThan(target.y + target.height + 60);
    const mover = await last.getAttribute("data-row");
    await mouseDrag(page, { x: from.x + 40, y: from.y + 12 }, { x: target.x + 60, y: from.y + 12 });
    await expect(later.locator(`[data-testid=db-card][data-row="${mover}"]`)).toHaveCount(1);
    expect((await dbRows(page, ids.db)).find((r) => r.id === mover).props[ids.stage]).toBe(ids.later);
    const cards = now.locator("[data-testid=db-card]");
    const order = await cards.evaluateAll((els) => els.map((e) => e.dataset.row));
    const third = await cards.nth(2).boundingBox();
    const first = await cards.first().boundingBox();
    await mouseDrag(page, { x: third.x + 40, y: third.y + 12 }, { x: first.x + 40, y: first.y + 4 });
    await expect.poll(async () => (await cards.evaluateAll((els) => els.map((e) => e.dataset.row)))[0]).toBe(order[2]);
    await expect(page.locator(".ProseMirror-selectednode")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.classList.contains("db-dragging"))).toBe(false);
    await page.screenshot({ path: `${shots}/${page.tag}-db-inline-drag.png` });
    await patchView(page, ids, { type: "table", groupBy: null });
    const rows = root.getByTestId("db-row");
    await expect(rows).toHaveCount(12);
    const tableOrder = await rows.evaluateAll((els) => els.map((e) => e.dataset.row));
    await rows.nth(3).hover();
    const rowHandle = await rows.nth(3).getByTestId("db-row-handle").boundingBox();
    const topRow = await rows.first().boundingBox();
    await mouseDrag(page, { x: rowHandle.x + rowHandle.width / 2, y: rowHandle.y + rowHandle.height / 2 }, { x: topRow.x + 80, y: topRow.y + 4 });
    await expect.poll(async () => (await rows.evaluateAll((els) => els.map((e) => e.dataset.row)))[0]).toBe(tableOrder[3]);
    await patchView(page, ids, { type: "list" });
    const items = root.getByTestId("db-list-row");
    await expect(items).toHaveCount(12);
    const listOrder = await items.evaluateAll((els) => els.map((e) => e.dataset.row));
    const fourth = await items.nth(4).boundingBox();
    const firstItem = await items.first().boundingBox();
    await mouseDrag(page, { x: fourth.x + 80, y: fourth.y + fourth.height / 2 }, { x: firstItem.x + 80, y: firstItem.y + 2 });
    await expect.poll(async () => (await items.evaluateAll((els) => els.map((e) => e.dataset.row)))[0]).toBe(listOrder[4]);
    await expect(page.locator(".ProseMirror-selectednode")).toHaveCount(0);
    await patchView(page, ids, { type: "board", groupBy: { prop: ids.stage } });
    if (page.tag === "webkit") return;
    await page.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
    await page.keyboard.type("after the board");
    const tailBlock = page.locator(".n-page-column .bn-block-content").filter({ hasText: "after the board" });
    await tailBlock.waitFor();
    const types = () => page.evaluate(() => [...document.querySelectorAll(".n-page-column .bn-editor .bn-block-content")].filter((e) => !e.parentElement.closest(".db-block")).map((e) => e.getAttribute("data-content-type")));
    expect((await types()).indexOf("database")).toBe(0);
    await root.getByTestId("db-title").hover();
    const handle = page.getByTestId("drag-handle");
    await expect(handle).toBeVisible();
    const grip = await handle.boundingBox();
    const tail = await tailBlock.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 2, grip.y + grip.height / 2 + 3);
    await page.mouse.move(tail.x + 60, tail.y + tail.height / 2, { steps: 10 });
    await page.mouse.move(tail.x + 60, tail.y + tail.height - 2, { steps: 4 });
    await expect(page.locator(".n-line-drop")).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(async () => (await types()).indexOf("database")).toBe(1);
  },

  async inlineDatabaseFocus(page) {
    const root = await boardPage(page, "Focus board");
    const ids = await seedBoard(page);
    const selected = () => page.locator(".ProseMirror-selectednode");
    const head = await column(root, ids.now).locator(".db-board-head").boundingBox();
    await page.mouse.click(head.x + head.width - 70, head.y + head.height / 2);
    await page.waitForTimeout(250);
    await expect(selected()).toHaveCount(0);
    const board = await root.getByTestId("db-board").boundingBox();
    await page.mouse.click(board.x + board.width - 20, board.y + board.height - 6);
    await page.waitForTimeout(250);
    await expect(selected()).toHaveCount(0);
    const title = root.getByTestId("db-title");
    await title.click();
    await expect(title).toBeFocused();
    await page.keyboard.type(" plan");
    await expect(title).toHaveValue(/ plan$/);
    const ring = await title.evaluate((el) => { const cs = getComputedStyle(el); return { outline: cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) === 0, shadow: cs.boxShadow }; });
    expect(ring).toEqual({ outline: true, shadow: "none" });
    await expect(selected()).toHaveCount(0);
    await page.locator(".n-page-column .bn-block-content").first().hover();
    await root.getByTestId("db-title").hover();
    const handle = page.getByTestId("drag-handle");
    await expect(handle).toBeVisible();
    await page.waitForTimeout(200);
    const centre = async (loc) => { const b = await loc.boundingBox(); return b.y + b.height / 2; };
    const titleLine = await title.evaluate((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.top + parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight) / 2; });
    expect(Math.abs((await centre(handle)) - titleLine)).toBeLessThanOrEqual(2);
    await page.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
    await page.keyboard.type("# Big heading");
    const heading = page.locator('.n-page-column [data-content-type="heading"] .bn-inline-content').filter({ hasText: "Big heading" });
    await heading.hover();
    await page.waitForTimeout(200);
    const headingLine = await heading.evaluate((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.top + parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight) / 2; });
    expect(Math.abs((await centre(handle)) - headingLine)).toBeLessThanOrEqual(2);
    const scroller = root.getByTestId("db-board");
    await scroller.evaluate((el) => (el.style.maxWidth = "320px"));
    await scroller.evaluate((el) => (el.scrollLeft = 400));
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await root.getByTestId("db-tab").filter({ hasText: "Second" }).click();
    await expect(root.getByTestId("db-tab").filter({ hasText: "Second" })).toHaveClass(/is-active/);
    expect(await root.getByTestId("db-board").evaluate((el) => el.scrollLeft)).toBe(0);
    await page.screenshot({ path: `${shots}/${page.tag}-db-inline-focus.png` });
  },

  async screenshots(page, browser, url) {
    for (const scheme of ["light", "dark"]) {
      const { context, page: p } = await open(browser, url, { scheme });
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-page.png` });
      await p.getByTestId("page-scroller").evaluate((el) => el.scrollTo(0, 600));
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-blocks.png` });
      await p.locator(".n-page-column .bn-block-content").filter({ hasText: "Press / to see" }).locator(".bn-inline-content").dblclick();
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-toolbar.png` });
      await p.getByTestId("workspace-switcher").click();
      await expect(p.getByTestId("workspace-menu")).toBeVisible();
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-workspaces.png` });
      await p.keyboard.press("Escape");
      await p.getByTestId("share-button").click();
      await expect(p.getByTestId("share-popover")).toBeVisible();
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-share.png` });
      await p.keyboard.press("Escape");
      await p.locator(".n-page-tail").click({ position: { x: 300, y: 10 } });
      await p.keyboard.type("/");
      await expect(p.getByTestId("slash-menu")).toBeVisible();
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-slash.png` });
      await p.keyboard.press("Escape");
      await p.keyboard.press("Backspace");
      const metrics = await p.evaluate(() => {
        const px = (sel) => {
          const el = document.querySelector(sel);
          return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
        };
        const editorEl = document.querySelector(".n-page-column .bn-editor");
        return {
          width: Math.round(editorEl.getBoundingClientRect().width),
          title: px(".n-title"),
          body: parseFloat(getComputedStyle(editorEl).fontSize),
          h2: px('.n-page-column [data-content-type="heading"][data-level="2"]'),
          h3: px('.n-page-column [data-content-type="heading"][data-level="3"]'),
          sidebar: Math.round(document.querySelector(".n-sidebar").getBoundingClientRect().width),
        };
      });
      expect(metrics).toEqual({ width: 708, title: 40, body: 16, h2: 24, h3: 20, sidebar: 240 });
      await p.getByTestId("nav-home").click();
      await p.screenshot({ path: `${shots}/${page.tag}-${scheme}-home.png` });
      expect(p.errors, p.errors.join("\n")).toEqual([]);
      await context.close();
    }
  },
};

async function run() {
  const server = await startServer();
  const results = [];
  try {
    for (const name of browsers) {
      const browser = await launcher(name)();
      for (const [scenario, fn] of Object.entries(scenarios)) {
        if (only && !only.includes(scenario)) continue;
        const started = Date.now();
        const { context, page } = await open(browser, server.url);
        page.tag = name;
        let error = null;
        try {
          await fn(page, browser, server.url);
          if (page.errors.length) throw new Error(`page errors:\n${page.errors.join("\n")}`);
        } catch (e) {
          error = e;
          await page.screenshot({ path: `${shots}/${name}-FAIL-${scenario}.png` }).catch(() => {});
        }
        await context.close();
        const ms = Date.now() - started;
        results.push({ browser: name, scenario, ok: !error, ms, error: error ? String(error.message ?? error).split("\n").slice(0, 16).join("\n") : "" });
        console.log(`${error ? "FAIL" : "ok  "} ${name.padEnd(8)} ${scenario.padEnd(28)} ${ms}ms${error ? `\n     ${String(error.message ?? error).split("\n").slice(0, 16).join("\n     ")}` : ""}`);
      }
      await browser.close();
    }
  } finally {
    server.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${shots}`);
  process.exit(failed.length ? 1 : 0);
}

await run();
