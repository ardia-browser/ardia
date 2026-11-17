#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchArdia } from "../../apps/linux/scripts/acceptance/lib/ardia.mjs";
import { connectCdp, evaluate } from "../../apps/linux/scripts/acceptance/lib/cdp.mjs";
import { until } from "../../apps/linux/scripts/acceptance/lib/util.mjs";

const USAGE = `usage: node scripts/linux/ubo-seed.mjs --chrome FILE --ui DIR --blocker DIR [--timeout-ms N]

Seeds the packaged uBlock Origin so a new profile filters from its first page.
Starts chrome on a scratch profile with the blocker in DIR, waits for uBlock
Origin to fetch and compile its default lists (from the packaged copies when
offline) and save its engine, and writes that storage to
DIR/ardia-seed/storage.json. DIR/js/start.js is patched to load the
seed into an empty profile when the profile's languages select no list the seed
lacks. Run it on the staged copy package.py makes, never on the vendor copy.

  --chrome FILE     the engine's chrome executable
  --ui DIR          the shell UI bundle (apps/linux/dist)
  --blocker DIR     the staged uBlock Origin directory to seed
  --timeout-ms N    deadline for uBlock Origin to save its engine (default 240000)`;

export const SEED_PATH = "ardia-seed/storage.json";
export const SELFIE_KEYS = ["cache/selfie/staticMain", "cache/selfie/staticNetFilteringEngine", "cache/selfie/staticExtFilteringEngine"];

const START_ANCHOR = "µb.isReadyPromise = (async function start() {\n    try {\n";
const SEED_LOADER = `const ardiaSeedFromPackage = async ( ) => {
    try {
        const stored = await vAPI.storage.get('version');
        if ( stored instanceof Object && stored.version !== undefined ) { return; }
        const response = await fetch('/${SEED_PATH}').catch(( ) => undefined);
        if ( response === undefined || response.ok !== true ) { return; }
        const seed = await response.json();
        if ( seed instanceof Object === false || seed.storage instanceof Object === false ) { return; }
        if ( seed.storage.version !== vAPI.app.version ) { return; }
        const selected = seed.storage.selectedFilterLists;
        if ( Array.isArray(selected) === false ) { return; }
        const assets = await fetch('/assets/assets.json').then(r => r.json());
        for ( const [ key, list ] of Object.entries(assets) ) {
            if ( list.content !== 'filters' || list.off !== true ) { continue; }
            if ( µb.listMatchesEnvironment(list) && selected.includes(key) === false ) { return; }
        }
        await vAPI.storage.set(seed.storage);
        ubolog(\`Storage seeded from the package \${Date.now()-vAPI.T0} ms after launch\`);
    } catch (reason) {
        ubolog(reason);
    }
};

`;

export function patchStart(source) {
  if (source.includes("const ardiaSeedFromPackage = ")) throw new Error("js/start.js already loads a package seed");
  if (source.split(START_ANCHOR).length !== 2) throw new Error("js/start.js no longer has exactly one start sequence to patch");
  return source.replace(START_ANCHOR, `${SEED_LOADER}${START_ANCHOR}        await ardiaSeedFromPackage();\n`);
}

export function defaultLists(assets) {
  return ["user-filters", ...Object.entries(assets).filter(([, list]) => list.content === "filters" && list.off !== true).map(([key]) => key)];
}

export function seedProblems(storage, assets) {
  const problems = [];
  if (typeof storage.version !== "string" || !storage.version) problems.push("no version");
  for (const key of SELFIE_KEYS) if (typeof storage[key] !== "string" || !storage[key]) problems.push(`no ${key}`);
  const selected = storage.selectedFilterLists;
  if (!Array.isArray(selected)) problems.push("no selectedFilterLists");
  else {
    const wanted = new Set(defaultLists(assets));
    const extra = selected.filter((key) => !wanted.has(key));
    const missing = [...wanted].filter((key) => !selected.includes(key));
    if (extra.length) problems.push(`selects lists beyond the defaults: ${extra.join(", ")}`);
    if (missing.length) problems.push(`misses default lists: ${missing.join(", ")}`);
  }
  return problems;
}

export function seedStorage(storage, assets) {
  const lists = new Set(Object.entries(assets).filter(([, list]) => list.content === "filters").map(([key]) => key));
  const kept = {};
  for (const [key, value] of Object.entries(storage)) {
    if (key.startsWith("ardia")) continue;
    if (key.startsWith("cache/compiled/")) continue;
    if (key.startsWith("cache/") && lists.has(key.slice("cache/".length))) continue;
    kept[key] = value;
  }
  return kept;
}

const SUMMARY = `chrome.storage.local.get(null).then((all) => JSON.stringify({ keys: Object.keys(all).length, version: all.version ?? null, selfie: ${JSON.stringify(SELFIE_KEYS)}.map((key) => typeof all[key] === "string" ? all[key].length : 0) }))`;
const EVERYTHING = "chrome.storage.local.get(null).then((all) => JSON.stringify(all))";

async function blockerStorage(app, expression) {
  const target = (await app.targets()).find((t) => t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.html"));
  if (!target) return null;
  const session = await connectCdp(target.webSocketDebuggerUrl, { commandTimeout: 120000 }).catch(() => null);
  if (!session) return null;
  try {
    return await evaluate(session, expression, { timeout: 120000, userGesture: false }).then((text) => JSON.parse(text)).catch(() => null);
  } finally {
    await session.close().catch(() => {});
  }
}

const saved = (summary) => !!summary && summary.selfie.every((length) => length > 0);
const sameSummary = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function seed({ chrome, ui, blocker, timeoutMs = 240000, log = console.error }) {
  const startPath = join(blocker, "js/start.js");
  const assets = JSON.parse(await readFile(join(blocker, "assets/assets.json"), "utf8"));
  await writeFile(startPath, patchStart(await readFile(startPath, "utf8")));
  await rm(join(blocker, "ardia-seed"), { recursive: true, force: true });
  const scratch = await mkdtemp(join(tmpdir(), "ardia-ubo-seed-"));
  const started = Date.now();
  let app;
  try {
    app = await launchArdia({
      executable: chrome,
      uiDir: ui,
      scratch,
      extensions: true,
      label: "ubo-seed",
      startTimeout: 60000,
      env: { LANG: "en_US.UTF-8", LANGUAGE: "en_US:en", LC_ALL: "en_US.UTF-8" },
      extraArgs: [`--ardia-content-blocker-dir=${blocker}`, "--lang=en-US"],
    });
    let last = null;
    let stable = 0;
    await until(async () => {
      const now = await blockerStorage(app, SUMMARY);
      stable = saved(now) && sameSummary(now, last) ? stable + 1 : 0;
      last = now;
      return stable >= 2;
    }, { timeout: timeoutMs, interval: 1000, label: "uBlock Origin to save its engine", abort: () => app.exitReason() });
    const storage = await blockerStorage(app, EVERYTHING);
    if (!storage) throw new Error("could not read uBlock Origin's storage");
    const problems = seedProblems(storage, assets);
    if (problems.length) throw new Error(`the seed is not the default list selection: ${problems.join("; ")}`);
    const kept = seedStorage(storage, assets);
    await mkdir(join(blocker, "ardia-seed"), { recursive: true });
    const text = JSON.stringify({ storage: kept });
    await writeFile(join(blocker, SEED_PATH), text);
    log(`ubo-seed: ${Object.keys(kept).length} keys, ${text.length} bytes, uBlock Origin ${storage.version}, ${Date.now() - started} ms`);
    return join(blocker, SEED_PATH);
  } finally {
    await app?.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "-h" || name === "--help") return { help: true };
    const value = argv[++i];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--chrome") options.chrome = resolve(value);
    else if (name === "--ui") options.ui = resolve(value);
    else if (name === "--blocker") options.blocker = resolve(value);
    else if (name === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`unknown option ${name}`);
  }
  if (!options.chrome || !options.ui || !options.blocker) throw new Error("--chrome, --ui and --blocker are required");
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) throw new Error("--timeout-ms must be a positive number");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(64);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    console.log(await seed(options));
    process.exit(0);
  } catch (error) {
    console.error(`ubo-seed: ${error.message}`);
    process.exit(1);
  }
}
