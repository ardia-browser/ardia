import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const uboScript = readFileSync(join(ROOT, "packages/ardiacore/scripts/ubo.sh"), "utf8");

const UBLOCK_VERSION = /^UBO_VERSION="([^"]+)"/m.exec(uboScript)[1];
const UBLOCK_SHA256 = /^UBO_SHA256="([0-9a-f]{64})"/m.exec(uboScript)[1];
const UBLOCK_CACHE = join(ROOT, "apps/browser/node_modules/.cache/ublock");
export const HIDING_CLEANUP = /^hiding_cleanup = r'''\n([\s\S]*?)^'''$/m.exec(uboScript)?.[1];

const ZIP = `uBlock0_${UBLOCK_VERSION}.chromium.zip`;
const URL_OF_ZIP = `https://github.com/gorhill/uBlock/releases/download/${UBLOCK_VERSION}/${ZIP}`;
const NEEDED = ["js/static-filtering-parser.js", "js/text-utils.js", "js/cosmetic-filtering.js", "lib/csstree/css-tree.js", "lib/publicsuffixlist/publicsuffixlist.js"];
const HOST_MODULES = {
  "js/background.js": "export default { hiddenSettings: { allowGenericProceduralFilters: false } };\n",
  "js/logger.js": "export default { writeOne() {}, enabled: false };\n",
};

export class OfflineError extends Error {}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function downloadOnce(target) {
  const response = await fetch(URL_OF_ZIP, { signal: AbortSignal.timeout(60_000) });
  if (response.status === 429 || response.status >= 500) return { transient: `HTTP ${response.status}` };
  if (!response.ok) throw new Error(`downloading uBlock Origin ${UBLOCK_VERSION}: HTTP ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return {};
}

async function download(target, attempts = 3) {
  const reasons = [];
  for (let i = 0; i < attempts; i++) {
    if (i) await pause(2000 * i);
    try {
      const { transient } = await downloadOnce(target);
      if (!transient) return;
      reasons.push(transient);
    } catch (error) {
      if (error.name !== "TypeError" && error.name !== "TimeoutError" && error.name !== "AbortError") throw error;
      reasons.push(error.cause?.code ?? error.message);
    }
  }
  throw new OfflineError(`couldn't download uBlock Origin ${UBLOCK_VERSION} (${reasons.join(", ")})`);
}

async function verifiedZip() {
  const vendored = join(ROOT, `packages/ardiacore/vendor/ubo/${ZIP}`);
  if (existsSync(vendored) && sha256(vendored) === UBLOCK_SHA256) return vendored;
  const cached = join(UBLOCK_CACHE, `${UBLOCK_SHA256}.zip`);
  if (existsSync(cached)) {
    if (sha256(cached) === UBLOCK_SHA256) return cached;
    rmSync(cached, { force: true });
  }
  mkdirSync(UBLOCK_CACHE, { recursive: true });
  const partial = `${cached}.${process.pid}.${randomUUID()}`;
  try {
    await download(partial);
    const got = sha256(partial);
    if (got !== UBLOCK_SHA256) throw new Error(`uBlock Origin ${UBLOCK_VERSION} downloaded with SHA-256 ${got}, not the ${UBLOCK_SHA256} ubo.sh pins`);
    renameSync(partial, cached);
  } finally {
    rmSync(partial, { force: true });
  }
  return cached;
}

function unpackedFresh(zip) {
  const root = mkdtempSync(join(tmpdir(), "ardia-ublock-"));
  try {
    execFileSync("unzip", ["-q", zip, "-d", root], { stdio: ["ignore", "ignore", "pipe"] });
    const tree = join(root, "uBlock0.chromium");
    for (const file of NEEDED) if (!existsSync(join(tree, file))) throw new Error(`uBlock Origin ${UBLOCK_VERSION} has no ${file}`);
    for (const [file, source] of Object.entries(HOST_MODULES)) writeFileSync(join(tree, file), source);
    return { root, tree };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const quietTimer = () => ({ on() {}, onidle() {}, offon() {}, off() {}, ongoing: () => false });

export async function pinnedUblock() {
  const { root: unpacked, tree: root } = unpackedFresh(await verifiedZip());
  globalThis.vAPI ??= { defer: { create: quietTimer, once: () => Promise.resolve() }, webextFlavor: { env: ["chromium", "ublock", "native_css_has"] } };
  const remove = () => rmSync(unpacked, { recursive: true, force: true });
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  try {
    const [sfp, { LineIterator }, cosmetic] = await Promise.all([load("js/static-filtering-parser.js"), load("js/text-utils.js"), load("js/cosmetic-filtering.js")]);
    return { sfp, LineIterator, cosmetic: cosmetic.default, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
