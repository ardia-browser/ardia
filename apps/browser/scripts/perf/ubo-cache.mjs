import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const UBO_ID = "fajbdaomknpkicfjcpipdmcpoamdmilh";
export const UBO_ENGINE_KEY_SETS = ["", "Ardia2"].map((infix) => ["Main", "NetFilteringEngine", "ExtFilteringEngine"].map((engine) => `cache/selfie/static${infix}${engine}`));
export const UBO_ENGINE_KEYS = UBO_ENGINE_KEY_SETS[0];

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const UBO_LOG_FLUSHED_BYTES = 1048576;

export const uboStoreDir = (dataDir) => join(dataDir, "Chromium", "Default", "Local Extension Settings", UBO_ID);
const uboIndexedDb = (dataDir, kind) => join(dataDir, "Chromium", "Default", "IndexedDB", `chrome-extension_${UBO_ID}_0.indexeddb.${kind}`);
export const uboBlobDir = (dataDir) => uboIndexedDb(dataDir, "blob");

function files(dir, recursive) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return recursive ? files(path, true) : [];
      return [{ path, size: statSync(path).size }];
    });
  } catch {
    return [];
  }
}

export const storeBytes = (dir, recursive = false) => files(dir, recursive).reduce((sum, f) => sum + f.size, 0);

export const uboLogBytes = (dataDir) => files(uboStoreDir(dataDir), false).filter((f) => f.path.endsWith(".log")).reduce((sum, f) => sum + f.size, 0);

export function uboSignature(dataDir) {
  return [uboStoreDir(dataDir), uboIndexedDb(dataDir, "leveldb"), uboBlobDir(dataDir)]
    .flatMap((dir) => files(dir, true)).map((f) => `${f.path}:${f.size}`).sort().join("\n");
}

export const uboSettled = (dataDir) => uboLogBytes(dataDir) < UBO_LOG_FLUSHED_BYTES;

const UBO_IDB_NAME = "uBlock0CacheStorage";

export const engineSaved = ({ local = [], indexedDB = [] } = {}) =>
  UBO_ENGINE_KEY_SETS.some((keys) => keys.every((key) => local.includes(key) && indexedDB.includes(key)));

const STORED_KEYS = `(async () => {
  const wanted = ${JSON.stringify(UBO_ENGINE_KEY_SETS.flat())};
  const local = Object.keys(await chrome.storage.local.get(wanted));
  const names = (await indexedDB.databases()).map((d) => d.name);
  if (!names.includes(${JSON.stringify(UBO_IDB_NAME)})) return { local, indexedDB: [] };
  const db = await new Promise((ok, fail) => { const r = indexedDB.open(${JSON.stringify(UBO_IDB_NAME)}); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
  try {
    if (!db.objectStoreNames.contains(${JSON.stringify(UBO_IDB_NAME)})) return { local, indexedDB: [] };
    const store = db.transaction(${JSON.stringify(UBO_IDB_NAME)}, "readonly").objectStore(${JSON.stringify(UBO_IDB_NAME)});
    const found = await Promise.all(wanted.map((key) => new Promise((ok) => { const q = store.getKey(key); q.onsuccess = () => ok(q.result === undefined ? null : key); q.onerror = () => ok(null); })));
    return { local, indexedDB: found.filter(Boolean) };
  } finally {
    db.close();
  }
})()`;

async function storedKeys(port) {
  let targets = [];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  } catch {
    return null;
  }
  const background = targets.find((t) => t.url.startsWith(`chrome-extension://${UBO_ID}/`) && t.webSocketDebuggerUrl);
  if (!background) return null;
  const socket = new WebSocket(background.webSocketDebuggerUrl);
  try {
    await new Promise((ok, fail) => ((socket.onopen = ok), (socket.onerror = fail), setTimeout(fail, 3000)));
    const reply = await new Promise((ok) => {
      const timer = setTimeout(() => ok(null), 5000);
      socket.onmessage = (m) => (clearTimeout(timer), ok(JSON.parse(m.data)));
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression: STORED_KEYS,
        awaitPromise: true, returnByValue: true,
      } }));
    });
    return reply?.result?.result?.value ?? null;
  } catch {
    return null;
  } finally {
    socket.close();
  }
}

export async function waitForUboEngine({ port, dataDir, deadlineMs = 120_000, quietMs = 10_000, pollMs = 500, log = () => {} }) {
  const start = Date.now();
  const end = start + deadlineMs;
  let saved = false;
  let stored = null;
  while (!saved && Date.now() < end) {
    stored = (await storedKeys(port)) ?? stored;
    saved = engineSaved(stored ?? undefined);
    if (!saved) await sleep(pollMs);
  }
  if (!saved) throw new Error(`uBlock Origin didn't save its compiled engine to both of its stores within ${deadlineMs / 1000} s (${JSON.stringify(stored)}); the template would start every run on a cold or fallback uBO cache`);
  let signature = uboSignature(dataDir);
  let still = Date.now();
  while (Date.now() - still < quietMs || !uboSettled(dataDir)) {
    if (Date.now() > end) throw new Error(`uBlock Origin's storage didn't settle within ${deadlineMs / 1000} s (log ${(uboLogBytes(dataDir) / 1048576).toFixed(1)} MB)`);
    await sleep(pollMs);
    const now = uboSignature(dataDir);
    if (now !== signature) (signature = now), (still = Date.now());
  }
  const secs = (Date.now() - start) / 1000;
  log(`uBO saved its compiled engine and its storage is settled (${Math.round(storeBytes(uboStoreDir(dataDir)) / 1048576)} MB store, ${Math.round(storeBytes(uboBlobDir(dataDir), true) / 1048576)} MB blobs, ${secs.toFixed(1)} s)`);
  return { secs, selfies: stored };
}
