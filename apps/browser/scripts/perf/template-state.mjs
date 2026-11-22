import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { uboBlobDir, uboLogBytes, uboStoreDir, storeBytes } from "./ubo-cache.mjs";

export const STARTUP_COMPONENTS = {
  hfnkpimlhhgieaddgfemjhofmfblmnib: "CertificateRevocation",
  efniojlnjndmcbiieegkicadnoecjjef: "PKIMetadata",
  giekcmmlnklenlaomppkphknjmnnpneh: "SSLErrorAssistant",
};

export const TEMPLATE_LIMITS = {
  uboStoreMB: [25, 50],
  uboBlobsMB: [15, 40],
  uboLogMB: 1,
  sidesUboStoreRatio: 1.2,
};

const MB = 1048576;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function installedVersion(dataDir, folder) {
  const dir = join(dataDir, "Chromium", folder);
  try {
    return readdirSync(dir).find((v) => existsSync(join(dir, v, "manifest.json"))) ?? null;
  } catch {
    return null;
  }
}

export function updaterChecked(dataDir) {
  try {
    const apps = JSON.parse(readFileSync(join(dataDir, "Chromium", "Local State"), "utf8")).updateclientdata?.apps ?? {};
    return Object.keys(apps).filter((id) => apps[id]?.dlrc != null);
  } catch {
    return [];
  }
}

export function componentsState(dataDir) {
  const checked = new Set(updaterChecked(dataDir));
  const components = Object.fromEntries(Object.entries(STARTUP_COMPONENTS).map(([id, folder]) =>
    [folder, { version: installedVersion(dataDir, folder), checked: checked.has(id) }]));
  return { components, settled: Object.values(components).every((c) => c.version) };
}

export async function waitForStartupComponents({ dataDir, launchedAt, deadlineMs = 150_000, pollMs = 1000, log = () => {} }) {
  const end = launchedAt + deadlineMs;
  let state = componentsState(dataDir);
  while (!state.settled && Date.now() < end) {
    await sleep(pollMs);
    state = componentsState(dataDir);
  }
  const shown = Object.entries(state.components).map(([k, c]) => `${k} ${c.version ?? (c.checked ? "answered, not installed" : "missing")}`).join(", ");
  if (!state.settled) throw new Error(`the component updater hadn't installed every startup component ${deadlineMs / 1000} s after launch (${shown}); every run would pay for them inside its idle window`);
  log(`startup components installed ${((Date.now() - launchedAt) / 1000).toFixed(1)} s after launch: ${shown}`);
  return { secs: (Date.now() - launchedAt) / 1000, ...state };
}

export function templateSizes(dataDir) {
  return {
    uboStoreMB: storeBytes(uboStoreDir(dataDir)) / MB,
    uboBlobsMB: storeBytes(uboBlobDir(dataDir), true) / MB,
    uboLogMB: uboLogBytes(dataDir) / MB,
  };
}

export function templateProblems(record, limits = TEMPLATE_LIMITS) {
  const problems = [];
  const { sizes, components } = record;
  const outside = (v, [lo, hi]) => !(v >= lo && v <= hi);
  if (outside(sizes.uboStoreMB, limits.uboStoreMB)) problems.push(`uBO's store is ${sizes.uboStoreMB.toFixed(1)} MB, outside ${limits.uboStoreMB.join("–")} MB`);
  if (outside(sizes.uboBlobsMB, limits.uboBlobsMB)) problems.push(`uBO's IndexedDB blobs are ${sizes.uboBlobsMB.toFixed(1)} MB, outside ${limits.uboBlobsMB.join("–")} MB`);
  if (sizes.uboLogMB > limits.uboLogMB) problems.push(`uBO's store has ${sizes.uboLogMB.toFixed(1)} MB still in its LevelDB log (a write wasn't flushed)`);
  for (const [name, c] of Object.entries(components ?? {})) if (!c.version) problems.push(`component ${name} isn't installed`);
  return problems;
}

export function sidesProblems(records, limits = TEMPLATE_LIMITS) {
  if (records.length < 2) return [];
  const stores = records.map((r) => r.sizes.uboStoreMB);
  const ratio = Math.max(...stores) / Math.min(...stores);
  return ratio > limits.sidesUboStoreRatio ? [`the templates' uBO stores differ ${ratio.toFixed(2)}× (${stores.map((s) => s.toFixed(1)).join(" vs ")} MB)`] : [];
}
