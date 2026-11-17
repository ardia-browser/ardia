import assert from "node:assert/strict";
import test from "node:test";
import { defaultLists, patchStart, SEED_PATH, seedProblems, seedStorage, SELFIE_KEYS } from "./ubo-seed.mjs";

const START = "const x = 1;\n\nµb.isReadyPromise = (async function start() {\n    try {\n        await µb.restoreAdminSettings();\n    } catch (ex) {}\n})();\n";
const ASSETS = {
  "assets.json": { content: "internal" },
  "ublock-filters": { content: "filters" },
  easylist: { content: "filters" },
  "DEU-0": { content: "filters", off: true, lang: "de" },
  "public_suffix_list.dat": { content: "internal" },
};
const VERSION = "1.76.0b25";

function storage(overrides = {}) {
  const base = { version: VERSION, selectedFilterLists: ["user-filters", "ublock-filters", "easylist"], "cache/easylist": "raw", "cache/compiled/easylist": "compiled", "cache/assets.json": "{}", assetCacheRegistry: "registry", ardiaReloadPending: true };
  for (const key of SELFIE_KEYS) base[key] = `selfie ${key}`;
  return { ...base, ...overrides };
}

async function runLoader({ stored = {}, seed = { storage: storage() }, languages = ["en"], appVersion = VERSION, seedMissing = false } = {}) {
  const loader = patchStart(START).split("µb.isReadyPromise")[0];
  const writes = [];
  const fetched = [];
  const vAPI = { T0: 0, app: { version: appVersion }, storage: { get: async () => stored, set: async (bin) => void writes.push(bin) } };
  const µb = { listMatchesEnvironment: (list) => typeof list.lang === "string" && list.lang.split(/\s+/).some((lang) => languages.includes(lang)) };
  const fetch = async (path) => {
    fetched.push(path);
    if (path === `/${SEED_PATH}`) {
      if (seedMissing) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => seed };
    }
    if (path === "/assets/assets.json") return { ok: true, json: async () => ASSETS };
    throw new Error(`unexpected fetch ${path}`);
  };
  const run = new Function("vAPI", "µb", "fetch", "ubolog", `${loader}\nreturn ardiaSeedFromPackage();`);
  await run(vAPI, µb, fetch, () => {});
  return { writes, fetched };
}

test("patching start.js loads the seed before uBlock Origin's own start sequence", () => {
  const patched = patchStart(START);
  assert.match(patched, /const ardiaSeedFromPackage = async/);
  assert.ok(patched.indexOf("await ardiaSeedFromPackage();") < patched.indexOf("await µb.restoreAdminSettings();"));
  assert.throws(() => patchStart(patched), /already loads a package seed/);
  assert.throws(() => patchStart("const x = 1;"), /no longer has exactly one start sequence/);
});

test("an empty profile in an English locale takes the seed", async () => {
  const { writes } = await runLoader();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, VERSION);
  assert.equal(writes[0]["cache/selfie/staticMain"], "selfie cache/selfie/staticMain");
});

test("a profile uBlock Origin already started in keeps its own storage", async () => {
  const { writes, fetched } = await runLoader({ stored: { version: "1.75.0b22" } });
  assert.deepEqual(writes, []);
  assert.deepEqual(fetched, []);
});

test("a locale that selects a regional list the seed lacks compiles its own lists", async () => {
  assert.deepEqual((await runLoader({ languages: ["de", "en"] })).writes, []);
  const withGerman = storage({ selectedFilterLists: ["user-filters", "ublock-filters", "easylist", "DEU-0"] });
  assert.equal((await runLoader({ languages: ["de"], seed: { storage: withGerman } })).writes.length, 1);
});

test("a seed from another uBlock Origin build, a malformed seed or no seed is ignored", async () => {
  assert.deepEqual((await runLoader({ appVersion: "1.77.0b26" })).writes, []);
  assert.deepEqual((await runLoader({ seed: { storage: storage({ selectedFilterLists: "all" }) } })).writes, []);
  assert.deepEqual((await runLoader({ seed: [] })).writes, []);
  assert.deepEqual((await runLoader({ seedMissing: true })).writes, []);
});

test("the default selection is user filters and every list not off by default", () => {
  assert.deepEqual(defaultLists(ASSETS), ["user-filters", "ublock-filters", "easylist"]);
});

test("a seed must hold a saved engine and exactly the default lists", () => {
  assert.deepEqual(seedProblems(storage(), ASSETS), []);
  assert.deepEqual(seedProblems(storage({ "cache/selfie/staticNetFilteringEngine": "" }), ASSETS), ["no cache/selfie/staticNetFilteringEngine"]);
  assert.deepEqual(seedProblems(storage({ selectedFilterLists: ["user-filters", "ublock-filters", "easylist", "DEU-0"] }), ASSETS), ["selects lists beyond the defaults: DEU-0"]);
  assert.deepEqual(seedProblems(storage({ selectedFilterLists: ["user-filters", "easylist"] }), ASSETS), ["misses default lists: ublock-filters"]);
  assert.deepEqual(seedProblems({}, ASSETS), ["no version", ...SELFIE_KEYS.map((key) => `no ${key}`), "no selectedFilterLists"]);
});

test("the seed keeps the saved engine and drops list copies uBlock Origin can rebuild and the bridge's own keys", () => {
  const kept = seedStorage(storage(), ASSETS);
  for (const key of [...SELFIE_KEYS, "version", "selectedFilterLists", "cache/assets.json", "assetCacheRegistry"]) assert.ok(key in kept, key);
  for (const key of ["cache/easylist", "cache/compiled/easylist", "ardiaReloadPending"]) assert.ok(!(key in kept), key);
});
