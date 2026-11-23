#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, scratchArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.error(
    "usage: favicon-peek-check.mjs <Ardia.app> [parent dir for the scratch dir]\nA private window shows a regular profile's stored icons, and its lookups leave that profile's Favicons database as it was: same size and modification time, same last_requested. A regular lookup afterwards does write, which shows the check would see a write.",
  );
  process.exit(appArg ? 0 : 64);
}
const parent = resolve(scratchArg ?? process.env.TMPDIR ?? "/tmp");
mkdirSync(parent, { recursive: true });
const scratch = mkdtempSync(join(parent, "ac-favicon-peek-"));
const data = join(scratch, "data");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const COMMIT_WAIT_MS = 15000;
const MONTH_US = 30 * 86400 * 1e6;

const onDemandPage = "https://on-demand.example/page";
const onDemandIcon = "https://on-demand.example/icon.png";
const otherPage = "https://on-demand.example/other";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const until = async (what, fn, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};

function faviconFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) faviconFiles(path, found);
    else if (entry.name === "Favicons") found.push(path);
  }
  return found;
}
const sql = (db, query) => execFileSync("sqlite3", ["-readonly", db, query], { encoding: "utf8" }).trim();
const write = (db, query) => execFileSync("sqlite3", [db, query], { encoding: "utf8" }).trim();
const quoted = (text) => `'${text.replaceAll("'", "''")}'`;
const lastRequested = (db) => sql(db, `SELECT b.last_requested FROM favicon_bitmaps b JOIN favicons f ON f.id = b.icon_id WHERE f.url = ${quoted(onDemandIcon)} ORDER BY b.id`);
const fileState = (db) =>
  ["", "-journal", "-wal"].map((suffix) => {
    try {
      const s = statSync(db + suffix);
      return `${suffix || "db"}:${s.size}:${s.mtimeMs}`;
    } catch {
      return `${suffix || "db"}:absent`;
    }
  }).join(" ");

const start = () => launch(appArg, { data, js: process.env.JS ?? "pinned", onboarded: true, session: session() });
const engine = (app, name, args) => app.eval(`return ac.engine.call(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((r) => ({ ok: r }), (e) => ({ error: String(e?.message ?? e) }))`, 30000);

let app;
try {
  app = await start();
  const profileId = await app.eval("return ac.store.getState().profileOrder[0]");
  const profile = await app.eval(`return ac.favicons.cacheKey(${JSON.stringify(profileId)})`);
  const stored = await until("the on-demand icons stored in the regular profile", async () => {
    const pages = await Promise.all([onDemandPage, otherPage].map((page) => engine(app, "favicons.set", { profile, page, icon: onDemandIcon, png: PNG })));
    return pages.every((r) => r.ok?.stored === true) ? pages : null;
  });
  check("the on-demand icon is stored in the regular profile", stored.length === 2);
  await app.quit();

  const db = faviconFiles(data).find((path) => sql(path, `SELECT count(*) FROM favicons WHERE url = ${quoted(onDemandIcon)}`) !== "0");
  if (!db) throw new Error("no Favicons database holds the on-demand icon");
  write(db, `UPDATE favicon_bitmaps SET last_requested = last_requested - ${MONTH_US} WHERE last_requested > 0 AND icon_id IN (SELECT id FROM favicons WHERE url = ${quoted(onDemandIcon)})`);
  const backdated = lastRequested(db);
  check("the on-demand icon's last_requested is backdated a month", backdated !== "" && backdated !== "0", backdated);

  app = await start();
  await sleep(COMMIT_WAIT_MS);
  const before = fileState(db);
  const windowId = await app.eval(`return ac.store.getState().createWindow({ kind: "private", profileId: ${JSON.stringify(profileId)} })`);
  const viewer = await app.eval(`return ac.store.getState().windows[${JSON.stringify(windowId)}].profileId`);
  check("a private window opened", typeof viewer === "string" && viewer.startsWith("incognito:"), viewer);
  await app.eval(`globalThis.__peekWatch = [${JSON.stringify(onDemandPage)}, ${JSON.stringify(otherPage)}].map((url) => ac.favicons.watchMissingFavicon({ url, profileId: ${JSON.stringify(viewer)} })); return true`);
  const shown = await until("the private window's icons", async () => {
    const found = await app.eval(`return [${JSON.stringify(onDemandPage)}, ${JSON.stringify(otherPage)}].map((url) => ac.favicons.resolveFavicon(url, null, ${JSON.stringify(viewer)})?.uri ?? null)`);
    return found.every(Boolean) ? found : null;
  });
  check("the private window shows the regular profile's icons", shown.every((uri) => uri.startsWith("data:image/png;base64,")));
  const regular = await app.eval(`const s = ac.favicons.useFavicons.getState(); return Object.keys(s.profiles).filter((k) => !k.startsWith("incognito:")).some((k) => s.profiles[k].pages[${JSON.stringify(onDemandPage)}] !== undefined)`);
  check("the private window's answers stay out of the regular profile's icon cache", regular === false);
  const privateEngine = `${viewer.slice(0, viewer.indexOf("@") + 1)}${profile}`;
  const asPrivate = await engine(app, "favicons.peek", { profile: privateEngine, pages: [onDemandPage], icons: [onDemandIcon], size: 32 });
  check("favicons.peek serves a private window's own call from its original profile", !!asPrivate.ok?.pages?.[onDemandPage]?.png && !!asPrivate.ok?.icons?.[onDemandIcon]?.png, JSON.stringify(asPrivate).slice(0, 160));
  const refused = await engine(app, "favicons.get", { profile: privateEngine, pages: [onDemandPage], icons: [], size: 32 });
  check("favicons.get still refuses a private window's call", !!refused.error, JSON.stringify(refused).slice(0, 160));
  for (let i = 0; i < 3; i++) await engine(app, "favicons.peek", { profile, pages: [onDemandPage, otherPage], icons: [onDemandIcon], size: 32 });
  await sleep(COMMIT_WAIT_MS);
  const after = fileState(db);
  check("the regular profile's Favicons database is untouched by the private lookups", after === before, `${before} -> ${after}`);
  await app.eval("for (const stop of globalThis.__peekWatch ?? []) stop(); return true");
  await app.quit();
  check("the on-demand icon's last_requested is unchanged", lastRequested(db) === backdated, `${backdated} -> ${lastRequested(db)}`);

  app = await start();
  await sleep(COMMIT_WAIT_MS);
  const controlBefore = fileState(db);
  await engine(app, "favicons.get", { profile, pages: [onDemandPage], icons: [], size: 32 });
  await sleep(COMMIT_WAIT_MS);
  const controlAfter = fileState(db);
  await app.quit();
  check("control: a regular lookup writes the database", controlAfter !== controlBefore, `${controlBefore} -> ${controlAfter}`);
  check("control: a regular lookup moves last_requested", lastRequested(db) !== backdated, `${backdated} -> ${lastRequested(db)}`);
} catch (e) {
  check("ran to the end", false, e.message);
  await app?.quit().catch(() => app.kill());
} finally {
  if (!failed) rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
