import { net } from "electron";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { dataDirectory } from "../paths";

const STORE = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/";
const REGISTRY = `${STORE}db/models.json`;
const CATALOG_MAX_AGE_MS = 7 * 86_400_000;
const FETCH_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
export const PIVOT = "en";
const RELEASED = ["Release", "Release Desktop"];
const ARCHITECTURES = ["base", "base-memory", "tiny"];

const KNOWN_FROM_ENGLISH =
  "af ar az be bg bn bs ca cs da de el es et eu fa fi fr gl gu he hi hr hu id is it ja kn ko lt lv ml mr ms nb nl pl pt ro ru sk sl sq sr sv ta te th tl tr ug uk ur vi zh-Hans zh-Hant";
const KNOWN_TO_ENGLISH = "af ar be bg bn ca cs da de el es et eu fa fi fr gl gu he hi hu id is it ja kn ko lt lv ml mr ms nb nl pl pt ro ru sk sl sq sv ta te th tl tr ug uk ur vi zh-Hans zh-Hant";

const REGISTRY_LANGUAGES: Record<string, string> = { zh: "zh-Hans", zh_hant: "zh-Hant", no: "nb" };
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?$/;
const STORE_PATH = /^models\/[A-Za-z0-9_\-./]+\.gz$/;
const HASH = /^[0-9a-f]{64}$/;
const FILE_TYPES = ["model", "lex", "vocab", "srcvocab", "trgvocab"] as const;
const REGISTRY_FILES: Record<string, FileType> = { model: "model", lexicalShortlist: "lex", vocab: "vocab", srcVocab: "srcvocab", trgVocab: "trgvocab" };
type FileType = (typeof FILE_TYPES)[number];

type RemoteFile = { path: string; hash?: string; size?: number };
type PairFiles = { version: string; files: Partial<Record<FileType, RemoteFile>> };
type Catalog = { source: string; fetchedAt: number; pairs: Record<string, PairFiles> };
type Manifest = { version: string; files: Partial<Record<FileType, { size: number }>> };

export type Progress = { received: number; total: number };
export type LoadedFiles = { model: string; lex: string; vocabs: string[] };

const folder = () => join(dataDirectory(), "Translations");
const catalogFile = () => join(folder(), "catalog.json");
const pairFolder = (pair: string) => join(folder(), pair.replace(">", "-"));
const manifestFile = (pair: string) => join(pairFolder(pair), "manifest.json");
export const pairKey = (from: string, to: string) => `${from}>${to}`;

let catalog: Catalog | null = readCatalog();
let refreshing: Promise<Catalog> | null = null;
const downloading = new Map<string, Promise<void>>();

function readCatalog(): Catalog | null {
  try {
    const parsed = JSON.parse(readFileSync(catalogFile(), "utf8")) as Catalog;
    return parsed.source === REGISTRY && typeof parsed.fetchedAt === "number" && parsed.pairs && typeof parsed.pairs === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const complete = (files: Partial<Record<FileType, unknown>>) => !!files.model && !!files.lex && (!!files.vocab || (!!files.srcvocab && !!files.trgvocab));

const rank = (entry: Record<string, unknown>) => RELEASED.indexOf(String(entry.releaseStatus)) * ARCHITECTURES.length + Math.max(0, ARCHITECTURES.indexOf(String(entry.architecture)));

function pairFiles(entry: Record<string, unknown>): PairFiles | null {
  const listed = entry.files;
  if (!listed || typeof listed !== "object") return null;
  const files: PairFiles["files"] = {};
  for (const [name, value] of Object.entries(listed as Record<string, unknown>)) {
    const type = REGISTRY_FILES[name];
    const file = value as Record<string, unknown> | null;
    if (!type || !file || typeof file.path !== "string" || !STORE_PATH.test(file.path) || file.path.includes("..")) continue;
    const hash = typeof file.uncompressedHash === "string" && HASH.test(file.uncompressedHash) ? file.uncompressedHash : undefined;
    const size = typeof file.uncompressedSize === "number" && file.uncompressedSize > 0 ? file.uncompressedSize : undefined;
    files[type] = { path: file.path, hash, size };
  }
  if (!complete(files) || !files.model?.hash) return null;
  return { version: files.model.path.split("/")[2] ?? files.model.hash, files };
}

export function catalogFromRegistry(models: unknown): Catalog["pairs"] {
  const pairs: Catalog["pairs"] = {};
  if (!models || typeof models !== "object") return pairs;
  for (const [key, entries] of Object.entries(models as Record<string, unknown>)) {
    const [rawFrom, rawTo, extra] = key.split("-");
    if (!rawFrom || !rawTo || extra !== undefined || !Array.isArray(entries)) continue;
    const from = REGISTRY_LANGUAGES[rawFrom] ?? rawFrom;
    const to = REGISTRY_LANGUAGES[rawTo] ?? rawTo;
    if (!LANGUAGE.test(from) || !LANGUAGE.test(to) || (from !== PIVOT && to !== PIVOT)) continue;
    const released = entries
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && RELEASED.includes(String((entry as Record<string, unknown>).releaseStatus)))
      .sort((a, b) => rank(a) - rank(b));
    const pair = pairKey(from, to);
    if (pairs[pair] && REGISTRY_LANGUAGES[rawFrom === PIVOT ? rawTo : rawFrom]) continue;
    for (const entry of released) {
      const files = pairFiles(entry);
      if (files) {
        pairs[pair] = files;
        break;
      }
    }
  }
  return pairs;
}

async function fetchCatalog(): Promise<Catalog> {
  const response = await net.fetch(REGISTRY, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`the language list answered ${response.status}`);
  const body = (await response.json()) as { models?: unknown };
  const pairs = catalogFromRegistry(body.models);
  if (!Object.keys(pairs).length) throw new Error("the language list was empty");
  const fresh: Catalog = { source: REGISTRY, fetchedAt: Date.now(), pairs };
  mkdirSync(folder(), { recursive: true });
  writeFileSync(`${catalogFile()}.tmp`, JSON.stringify(fresh));
  renameSync(`${catalogFile()}.tmp`, catalogFile());
  catalog = fresh;
  return fresh;
}

async function currentCatalog(): Promise<Catalog> {
  if (catalog && Date.now() - catalog.fetchedAt < CATALOG_MAX_AGE_MS) return catalog;
  refreshing ??= fetchCatalog().finally(() => (refreshing = null));
  try {
    return await refreshing;
  } catch (error) {
    if (catalog) return catalog;
    throw error;
  }
}

function knownPairs(): Set<string> {
  if (catalog) return new Set(Object.keys(catalog.pairs));
  const known = new Set<string>();
  for (const language of KNOWN_FROM_ENGLISH.split(" ")) known.add(pairKey(PIVOT, language));
  for (const language of KNOWN_TO_ENGLISH.split(" ")) known.add(pairKey(language, PIVOT));
  return known;
}

export function route(from: string, to: string): string[] | null {
  if (from === to) return null;
  const known = knownPairs();
  if (from === PIVOT || to === PIVOT) return known.has(pairKey(from, to)) ? [pairKey(from, to)] : null;
  const first = pairKey(from, PIVOT);
  const second = pairKey(PIVOT, to);
  return known.has(first) && known.has(second) ? [first, second] : null;
}

export function languages(): string[] {
  const out = new Set<string>([PIVOT]);
  for (const pair of knownPairs()) {
    const [from, to] = pair.split(">") as [string, string];
    out.add(from === PIVOT ? to : from);
  }
  return [...out];
}

function readManifest(pair: string): Manifest | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile(pair), "utf8")) as Manifest;
    for (const [type, file] of Object.entries(manifest.files)) {
      if (!file || statSync(join(pairFolder(pair), type)).size !== file.size) return null;
    }
    return complete(manifest.files) ? manifest : null;
  } catch {
    return null;
  }
}

export const installed = (pair: string) => readManifest(pair) !== null;

export function filesOf(pair: string): LoadedFiles | null {
  const manifest = readManifest(pair);
  if (!manifest) return null;
  const at = (type: FileType) => join(pairFolder(pair), type);
  const vocabs = manifest.files.vocab ? [at("vocab")] : [at("srcvocab"), at("trgvocab")];
  return { model: at("model"), lex: at("lex"), vocabs };
}

type Transfer = { type: FileType; file: RemoteFile; response: Response; length: number };

async function startTransfer(type: FileType, file: RemoteFile): Promise<Transfer> {
  const response = await net.fetch(`${STORE}${file.path}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
  return { type, file, response, length: Number(response.headers.get("content-length")) || 0 };
}

async function finishTransfer({ file, response }: Transfer, path: string, onBytes: (count: number) => void): Promise<number> {
  const staging = `${path}.part`;
  const handle = await open(staging, "w", 0o644);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const gunzip = createGunzip();
    const written = (async () => {
      for await (const chunk of gunzip as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        if (file.size !== undefined && size > file.size) throw new Error("the download was larger than expected");
        hash.update(chunk);
        await handle.write(chunk);
      }
    })();
    const reader = response.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onBytes(value.byteLength);
        if (!gunzip.write(value)) await new Promise((resolve) => gunzip.once("drain", resolve));
      }
      gunzip.end();
      await written;
    } catch (error) {
      gunzip.destroy();
      await written.catch(() => {});
      throw error;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if ((file.size !== undefined && size !== file.size) || (file.hash !== undefined && hash.digest("hex") !== file.hash)) {
    rmSync(staging, { force: true });
    throw new Error("the download didn't match Mozilla's checksum");
  }
  renameSync(staging, path);
  return size;
}

async function downloadPair(pair: string, entry: PairFiles, onLength: (length: number) => void, onBytes: (count: number) => void): Promise<void> {
  const target = pairFolder(pair);
  mkdirSync(target, { recursive: true });
  rmSync(manifestFile(pair), { force: true });
  const transfers = await Promise.all(FILE_TYPES.filter((type) => entry.files[type]).map((type) => startTransfer(type, entry.files[type]!)));
  for (const transfer of transfers) onLength(transfer.length);
  const sizes = await Promise.all(transfers.map((transfer) => finishTransfer(transfer, join(target, transfer.type), onBytes)));
  const manifest: Manifest = { version: entry.version, files: {} };
  transfers.forEach((transfer, i) => (manifest.files[transfer.type] = { size: sizes[i]! }));
  writeFileSync(`${manifestFile(pair)}.tmp`, JSON.stringify(manifest));
  renameSync(`${manifestFile(pair)}.tmp`, manifestFile(pair));
}

export async function ensurePairs(pairs: string[], onProgress: (progress: Progress) => void): Promise<number> {
  const missing = pairs.filter((pair) => !installed(pair));
  if (!missing.length) return 0;
  const fresh = await currentCatalog();
  const entries = missing.map((pair) => {
    const entry = fresh.pairs[pair];
    if (!entry) throw new Error(`Mozilla doesn't offer ${pair.replace(">", " to ")} any more`);
    return [pair, entry] as const;
  });
  let received = 0;
  let total = 0;
  const report = () => onProgress({ received: Math.min(received, total), total });
  const lengthKnown = (length: number) => {
    total += length;
    report();
  };
  const counted = (count: number) => {
    received += count;
    report();
  };
  await Promise.all(
    entries.map(([pair, entry]) => {
      const running = downloading.get(pair) ?? downloadPair(pair, entry, lengthKnown, counted).finally(() => downloading.delete(pair));
      downloading.set(pair, running);
      return running;
    }),
  );
  return missing.length;
}
