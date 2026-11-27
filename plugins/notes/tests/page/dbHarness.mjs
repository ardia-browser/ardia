import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, webkit } from "../../../../node_modules/playwright/index.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export const WS = "d0d0d0d0d0d0";
export const IDS = { tasks: "da7aba5e0001", projects: "da7aba5e0002", big: "da7aba5e0003", empty: "da7aba5e0004", host: "da7aba5e0005", inline: "da7aba5e0006", linked: "da7aba5e0007" };

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

export async function startHarness() {
  if (process.env.DB_HARNESS_URL) return { url: process.env.DB_HARNESS_URL, stop: async () => {} };
  const port = await freePort();
  const out = mkdtempSync(join(tmpdir(), "notes-db-harness-"));
  const child = spawn(process.execPath, [join(root, "src/page/database/dev/serve.mjs")], { env: { ...process.env, DB_DEV_PORT: String(port), DB_DEV_OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`harness exited: ${log}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`harness did not start: ${log}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/harness.js`, { method: "HEAD" });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: async () => {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    },
  };
}

function webkitPath() {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  for (const rev of ["2370", "2388"]) {
    const p = join(cache, `webkit-${rev}`, "pw_run.sh");
    if (existsSync(p)) return p;
  }
  return undefined;
}

function chromiumBundled() {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

export const BROWSERS = (process.env.DB_BROWSERS ?? "chromium,webkit").split(",").filter(Boolean);

export async function launch(name) {
  if (name === "webkit") {
    const executablePath = webkitPath();
    return webkit.launch(executablePath ? { executablePath } : {});
  }
  return chromium.launch(chromiumBundled() ? {} : { channel: "chrome" });
}

export async function openPage(browser, url, { colorScheme = "light", viewport = { width: 1360, height: 860 } } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForSelector('[data-testid="db-page"], [data-testid="h-main"]', { timeout: 15000 });
  return { context, page, errors };
}

export async function gotoDb(page, base, db, view = null, extra = "") {
  await page.evaluate(
    ([db, view, extra]) => {
      const q = new URLSearchParams(extra);
      q.set("db", db);
      if (view) q.set("v", view);
      history.pushState(null, "", `?${q}`);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    [db, view, extra],
  );
  await page.waitForSelector('[data-testid="db-view"]', { timeout: 15000 });
}

export async function evalModel(page, fn, arg) {
  return page.evaluate(
    ([src, arg]) => {
      const f = new Function("db", "arg", `return (${src})(db, arg);`);
      return f(window.__db, arg);
    },
    [fn.toString(), arg ?? null],
  );
}

export async function rowsOf(page, db) {
  return evalModel(
    page,
    (d, db) => {
      const tree = d.client.internals.docs.get(`${d.WS}|${d.treeDocId}`);
      const out = [];
      tree.getMap("pages").forEach((entry, id) => {
        const j = entry.toJSON();
        if (j.parent === db && !j.deleted && !j.archivedAt && !j.isTemplate) out.push({ id, title: j.title, props: j.props ?? {}, order: j.order });
      });
      return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    },
    db,
  );
}

export async function schemaOf(page, db) {
  return evalModel(
    page,
    (d, db) => {
      const doc = d.client.internals.docs.get(`${d.WS}|${d.pageDocId(db)}`);
      return d.readSchema(doc).map((p) => ({ id: p.id, name: p.name, type: p.type, options: p.options.map((o) => ({ id: o.id, name: o.name, group: o.group })), expression: p.expression }));
    },
    db,
  );
}

export async function relay(a, b) {
  await a.exposeFunction("__notesMockRelay", (msg) => b.evaluate((m) => window.__notesMockDeliver?.(m), msg).catch(() => {}));
  await b.exposeFunction("__notesMockRelay", (msg) => a.evaluate((m) => window.__notesMockDeliver?.(m), msg).catch(() => {}));
}

export async function waitFor(fn, { timeout = 5000, interval = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function dragBy(page, locator, dx, dy, steps = 8) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box to drag");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
  await page.mouse.up();
}

export async function dragTo(page, from, to, { fromPos, toPos, steps = 10 } = {}) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("no box to drag");
  const sx = a.x + (fromPos?.x ?? a.width / 2);
  const sy = a.y + (fromPos?.y ?? a.height / 2);
  const tx = b.x + (toPos?.x ?? b.width / 2);
  const ty = b.y + (toPos?.y ?? b.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
  await page.mouse.up();
}

export const SHOTS = process.env.DB_SHOTS ?? join(tmpdir(), "notes-db-shots");
