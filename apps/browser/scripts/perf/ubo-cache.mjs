import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const UBO_ID = "fajbdaomknpkicfjcpipdmcpoamdmilh";
export const UBO_ENGINE_KEYS = ["cache/selfie/staticMain", "cache/selfie/staticNetFilteringEngine", "cache/selfie/staticExtFilteringEngine"];

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export const uboStoreDir = (dataDir) => join(dataDir, "Chromium", "Default", "Local Extension Settings", UBO_ID);

export function storeBytes(dir) {
  try {
    return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  } catch {
    return 0;
  }
}

export const engineSaved = (keys) => UBO_ENGINE_KEYS.every((key) => keys.includes(key));

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
        expression: `chrome.storage.local.get(${JSON.stringify(UBO_ENGINE_KEYS)}).then((found) => Object.keys(found))`,
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

export async function waitForUboEngine({ port, dataDir, deadlineMs = 90_000, quietMs = 3000, pollMs = 500, log = () => {} }) {
  const start = Date.now();
  const end = start + deadlineMs;
  let saved = false;
  while (!saved && Date.now() < end) {
    saved = engineSaved((await storedKeys(port)) ?? []);
    if (!saved) await sleep(pollMs);
  }
  if (!saved) throw new Error(`uBlock Origin didn't save its compiled engine within ${deadlineMs / 1000} s; the template would start every run with a cold uBO cache`);
  const dir = uboStoreDir(dataDir);
  let bytes = storeBytes(dir);
  let still = Date.now();
  while (Date.now() - still < quietMs) {
    if (Date.now() > end) throw new Error(`uBlock Origin's storage kept changing for ${deadlineMs / 1000} s after it saved its engine`);
    await sleep(pollMs);
    const now = storeBytes(dir);
    if (now !== bytes) (bytes = now), (still = Date.now());
  }
  log(`uBO saved its compiled engine and its storage is quiet (${Math.round(bytes / 1048576)} MB, ${((Date.now() - start) / 1000).toFixed(1)} s)`);
}
