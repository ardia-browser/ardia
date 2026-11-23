import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { templateProblems, templateSizes } from "./template-state.mjs";

const TEMPLATE_CACHE_REVISION = 2;
export const TEMPLATE_MAX_AGE_HOURS = 12;
const PRUNE_AFTER_HOURS = 2 * TEMPLATE_MAX_AGE_HOURS;
const STAGING_ABANDONED_HOURS = 2;

const ENTRY = "entry.json";

const plistValue = (app, key) => {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", join(app, "Contents/Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

export const fileSha256 = (file) => (file && existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);

export function uboVersion(app) {
  try {
    return JSON.parse(readFileSync(join(app, "Contents/Resources/Extensions/ublock/manifest.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

const appCdhash = (app) => spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" }).stderr?.match(/^CDHash=([0-9a-f]+)$/m)?.[1] ?? null;

export function appIdentity(app) {
  return { version: plistValue(app, "CFBundleShortVersionString"), build: plistValue(app, "CFBundleVersion"), cdhash: appCdhash(app), ubo: uboVersion(app) };
}

export function templateKey({ identity, bundleSha, pagePort, recipe = "session", revision = TEMPLATE_CACHE_REVISION, ...rest }) {
  return { revision, recipe, version: identity.version, build: identity.build, cdhash: identity.cdhash, ubo: identity.ubo, bundleSha, pagePort, ...rest };
}

export const keyId = (key) => createHash("sha256").update(JSON.stringify(Object.keys(key).sort().map((k) => [k, key[k]]))).digest("hex").slice(0, 16);

export function keyProblems(key) {
  return Object.entries(key).filter(([, v]) => v === null || v === undefined || v === "" || v === 0).map(([k]) => `the key's ${k} is unknown`);
}

export function defaultCacheDir(src, out) {
  const app = resolve(src);
  const exportDir = dirname(app);
  if (basename(exportDir) === "export" && basename(dirname(dirname(exportDir))) === "dist") return join(dirname(exportDir), "bench", "templates");
  return join(out, ".templates");
}

const sameSizes = (a, b) => ["uboStoreMB", "uboBlobsMB", "uboLogMB"].every((k) => Number.isFinite(a?.[k]) && Math.abs(a[k] - b?.[k]) < 1e-9);

export function cloneTree(from, to) {
  if (process.platform === "darwin") execFileSync("cp", ["-Rc", from, to]);
  else cpSync(from, to, { recursive: true });
}

export function componentDrift(recorded, installed) {
  if (!recorded || !installed) return [];
  return Object.entries(recorded).filter(([name, c]) => installed[name]?.version !== c?.version)
    .map(([name, c]) => `component ${name} is ${installed[name]?.version ?? "missing"}, recorded ${c?.version ?? "none"}`);
}

export function entryProblems(entry, key, { now = Date.now(), maxAgeHours = TEMPLATE_MAX_AGE_HOURS, sizes = null, components = null, validate = templateProblems } = {}) {
  if (!entry) return ["no cached template"];
  const problems = [];
  for (const k of new Set([...Object.keys(key), ...Object.keys(entry.key ?? {})]))
    if (entry.key?.[k] !== key[k]) problems.push(`${k} changed (${entry.key?.[k] ?? "none"} → ${key[k] ?? "none"})`);
  const made = Date.parse(entry.made);
  const ageHours = (now - made) / 3600_000;
  if (!Number.isFinite(made) || ageHours < 0) problems.push("it has no valid date");
  else if (ageHours > maxAgeHours) problems.push(`it is ${ageHours.toFixed(1)} h old, over ${maxAgeHours} h (startup components and uBO's lists move)`);
  if (!entry.record) problems.push("it has no template record");
  else {
    problems.push(...validate(entry.record));
    if (sizes && !sameSizes(sizes, entry.record.sizes)) problems.push("its files changed since it was stored");
    problems.push(...componentDrift(entry.record.components, components));
  }
  return problems;
}

const generations = (keyDir) => {
  try {
    return readdirSync(keyDir).filter((g) => /^\d+-\d+-[0-9a-f]+$/.test(g)).sort((a, b) => +b.split("-")[0] - +a.split("-")[0]);
  } catch {
    return [];
  }
};

function checkTemplate(dir, entry, key, { sizesOf = templateSizes, componentsOf = null, ...opts } = {}) {
  if (!existsSync(dir)) return ["no cached template"];
  return entryProblems(entry, key, { ...opts, sizes: sizesOf(dir), components: componentsOf?.(dir) ?? null });
}

export function lookupTemplate(cacheDir, key, opts = {}) {
  const keyDir = join(cacheDir, keyId(key));
  let problems = ["no cached template"];
  for (const g of generations(keyDir)) {
    const dir = join(keyDir, g);
    let entry = null;
    try {
      entry = JSON.parse(readFileSync(join(dir, ENTRY), "utf8"));
    } catch {}
    const template = join(dir, "template");
    const found = checkTemplate(template, entry, key, opts);
    if (!found.length) return { hit: true, dir, template, entry };
    if (problems[0] === "no cached template") problems = found;
  }
  return { hit: false, problems, dir: keyDir };
}

export function storeTemplate(cacheDir, key, templateDir, record, { now = Date.now(), pair = null } = {}) {
  const keyDir = join(cacheDir, keyId(key));
  const dir = join(keyDir, `${now}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const staging = join(keyDir, `.staging-${basename(dir)}`);
  try {
    mkdirSync(staging, { recursive: true });
    cloneTree(templateDir, join(staging, "template"));
    writeFileSync(join(staging, ENTRY), JSON.stringify({ key, made: new Date(now).toISOString(), pair, record }, null, 2));
    renameSync(staging, dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  pruneCache(cacheDir, { now });
  return dir;
}

export function storePair(entries, problems, { now = Date.now() } = {}) {
  if (problems.length) return [];
  const pair = randomBytes(8).toString("hex");
  return entries.map(({ cacheDir, key, templateDir, record }) => storeTemplate(cacheDir, key, templateDir, record, { now, pair }));
}

const madeAt = (name) => +name.replace(/^\.staging-/, "").split("-")[0];

export function pruneCache(cacheDir, { now = Date.now() } = {}) {
  const removed = [];
  let keys = [];
  try {
    keys = readdirSync(cacheDir).filter((k) => /^[0-9a-f]{16}$/.test(k));
  } catch {
    return removed;
  }
  for (const k of keys) {
    let names = [];
    try {
      names = readdirSync(join(cacheDir, k));
    } catch {
      continue;
    }
    for (const name of names) {
      const staging = name.startsWith(".staging-");
      const age = now - madeAt(name);
      if (!Number.isFinite(age) && !name.startsWith(".deleting-")) continue;
      const deleting = name.startsWith(".deleting-");
      if (deleting || (staging && age > STAGING_ABANDONED_HOURS * 3600_000) || (!staging && generations(join(cacheDir, k)).includes(name) && age > PRUNE_AFTER_HOURS * 3600_000)) {
        const gone = deleting ? join(cacheDir, k, name) : join(cacheDir, k, `.deleting-${name}-${process.pid}-${randomBytes(2).toString("hex")}`);
        try {
          if (!deleting) renameSync(join(cacheDir, k, name), gone);
          rmSync(gone, { recursive: true, force: true });
        } catch {}
        removed.push(join(k, name));
      }
    }
  }
  return removed;
}

export function copyCachedTemplate(hit, templateDir, opts = {}) {
  rmSync(templateDir, { recursive: true, force: true });
  mkdirSync(dirname(templateDir), { recursive: true });
  let problems;
  try {
    cloneTree(hit.template, templateDir);
    problems = existsSync(hit.template) ? checkTemplate(templateDir, hit.entry, hit.entry.key, { ...opts, maxAgeHours: Infinity }) : ["it was removed during the copy"];
  } catch (error) {
    problems = [`the copy failed (${error.code ?? error.message.split("\n")[0]})`];
  }
  if (problems.length) rmSync(templateDir, { recursive: true, force: true });
  return { ok: !problems.length, problems };
}

export function sourceChanged(recorded, current) {
  if (!recorded) return [];
  return ["version", "build", "cdhash"].filter((k) => recorded[k] !== current?.[k]).map((k) => `its ${k} is ${current?.[k] ?? "unknown"}, the copy was made from ${recorded[k] ?? "unknown"}`);
}

export const cachedAgeHours = (entry, now = Date.now()) => (now - Date.parse(entry.made)) / 3600_000;
