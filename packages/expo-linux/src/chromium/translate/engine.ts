import glueUrl from "@browsermt/bergamot-translator/worker/bergamot-translator-worker.js?url";
import wasmUrl from "@browsermt/bergamot-translator/worker/bergamot-translator-worker.wasm?url";
import type { BrowserModelFiles, BrowserWorkerReply, BrowserWorkerRequest, BrowserWorkerText } from "./worker";
import { alignedParts, piecesHtml } from "./pieces";

export type TranslationHost = {
  modelFiles(source: string, target: string): Promise<{ key: string; files: BrowserModelFiles }[] | null>;
  count(name: string): void;
  note(message: string): void;
};

export const translationLimits = {
  passageBytes: 64 * 1024,
  requestBytes: 64 * 1024,
  requestPassages: 64,
  queuedPerOwner: 8,
  openOwners: 256,
  deadlineBaseMs: 20_000,
  deadlinePerKiBMs: 1_500,
  memoBytes: 8 * 1024 * 1024,
};

const IDLE_MS = 60_000;
const MEMO_LIMIT = 5000;
const DIRECT = "\u0000direct";
const encoder = new TextEncoder();

let host: TranslationHost = { modelFiles: async () => null, count: () => {}, note: () => {} };

export function useTranslationHost(chosen: TranslationHost): void {
  host = chosen;
}

class Cancelled extends Error {}

type Job = {
  owner: string;
  models: { key: string; files: BrowserModelFiles }[];
  texts: BrowserWorkerText[];
  bytes: number;
  resolve: (translated: string[]) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running: { job: Job; id: number; timer: ReturnType<typeof setTimeout> } | null = null;
const queue: Job[] = [];
const owners = new Set<string>();
const memo = new Map<string, string[]>();
let memoBytes = 0;

const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

function startWorker(): Worker {
  const started = new Worker(new URL("./worker.ts", import.meta.url), { type: "classic" });
  started.addEventListener("message", (event: MessageEvent) => {
    const { id, result, error } = event.data as BrowserWorkerReply;
    if (worker !== started) return;
    if (error !== undefined) finish(id, new Error(error));
    else finish(id, null, result as string[]);
  });
  started.addEventListener("error", (event: ErrorEvent) => {
    host.count("translate_engine_failures");
    host.note(`the engine failed: ${event.message}`);
    if (worker === started) stopWorker("the translation engine stopped");
  });
  started.postMessage({ op: "start", glue: glueUrl, wasm: wasmUrl } satisfies BrowserWorkerRequest);
  return started;
}

function stopWorker(reason: string) {
  const stopping = worker;
  worker = null;
  stopping?.terminate();
  if (running) finish(running.id, new Error(reason));
}

function stopWhenIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (running || queue.length || !worker) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!running && !queue.length) stopWorker("idle");
  }, IDLE_MS);
}

const deadlineFor = (bytes: number) => translationLimits.deadlineBaseMs + Math.ceil(bytes / 1024) * translationLimits.deadlinePerKiBMs;

function pump() {
  if (running || !queue.length) return stopWhenIdle();
  const job = queue.shift()!;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  worker ??= startWorker();
  const id = ++nextId;
  const timer = setTimeout(() => {
    if (running?.id !== id) return;
    host.count("translate_engine_timeouts");
    host.note(`the engine took longer than ${deadlineFor(job.bytes)} ms on ${job.bytes} bytes; starting a fresh one`);
    stopWorker("the translation took too long");
  }, deadlineFor(job.bytes));
  running = { job, id, timer };
  worker.postMessage({ op: "translate", id, models: job.models, texts: job.texts });
}

function finish(id: number, error: Error | null, result?: string[]) {
  if (!running || running.id !== id) return;
  const { job, timer } = running;
  clearTimeout(timer);
  running = null;
  if (error) job.reject(error);
  else if (!Array.isArray(result) || result.length !== job.texts.length) job.reject(new Error("the translation engine answered out of step"));
  else job.resolve(result);
  pump();
}

function enqueue(owner: string, models: Job["models"], texts: BrowserWorkerText[], bytes: number): Promise<string[]> {
  const waiting = queue.filter((job) => job.owner === owner).length + (running?.job.owner === owner ? 1 : 0);
  if (waiting >= translationLimits.queuedPerOwner) {
    host.count("translate_requests_refused");
    return Promise.reject(new Error("too many translations are already waiting for this page"));
  }
  return new Promise((resolve, reject) => {
    queue.push({ owner, models, texts, bytes, resolve, reject });
    pump();
  });
}

async function modelsFor(source: string, target: string): Promise<Job["models"]> {
  const found = await host.modelFiles(source, target);
  if (!found) throw new Error(`the ${source} to ${target} language files aren't downloaded`);
  const absolute = (path: string) => new URL(path, `${location.origin}/`).href;
  return found.map(({ key, files }) => ({ key, files: { model: absolute(files.model), lex: absolute(files.lex), vocabs: files.vocabs.map(absolute) } }));
}

type Sized = { text: string; bytes: number };

function sized(text: unknown): Sized | null {
  if (typeof text !== "string" || text.length > translationLimits.passageBytes) return null;
  const bytes = utf8Bytes(text);
  return bytes <= translationLimits.passageBytes ? { text, bytes } : null;
}

function refuseRequest(reason: string): never {
  host.count("translate_requests_refused");
  throw new Error(reason);
}

function checkRequest(length: number, bytes: number) {
  if (length > translationLimits.requestPassages) refuseRequest(`too many passages at once (${length})`);
  if (bytes > translationLimits.requestBytes) refuseRequest(`too much text at once (${bytes} bytes)`);
}

export async function translateTexts(source: string, target: string, texts: string[]): Promise<(string | null)[]> {
  if (!Array.isArray(texts)) refuseRequest("the texts weren't a list");
  if (!texts.length) return [];
  checkRequest(texts.length, 0);
  const accepted = texts.map(sized);
  const refused = accepted.filter((entry) => !entry).length;
  if (refused) host.count("translate_passages_refused");
  const fresh = accepted.flatMap((entry, i) => (entry ? [{ ...entry, i }] : []));
  const bytes = fresh.reduce((sum, entry) => sum + entry.bytes, 0);
  checkRequest(texts.length, bytes);
  const out: (string | null)[] = texts.map(() => null);
  if (!fresh.length) return out;
  const models = await modelsFor(source, target);
  const translated = await enqueue(
    DIRECT,
    models,
    fresh.map(({ text }) => ({ text, html: false })),
    bytes,
  );
  fresh.forEach(({ i }, k) => (out[i] = typeof translated[k] === "string" ? translated[k]! : null));
  return out;
}

const memoKey = (source: string, target: string, pieces: string[]) => `${source}>${target}\u0000${pieces.join("\u0001")}`;

function remember(key: string, parts: string[]) {
  const bytes = key.length + parts.reduce((sum, part) => sum + part.length, 0);
  if (memo.size >= MEMO_LIMIT || memoBytes + bytes > translationLimits.memoBytes) {
    memo.clear();
    memoBytes = 0;
  }
  memo.set(key, parts);
  memoBytes += bytes;
}

function passageOf(pieces: unknown): { pieces: string[]; bytes: number } | null {
  if (!Array.isArray(pieces) || !pieces.length || pieces.length > translationLimits.requestPassages) return null;
  let bytes = 0;
  for (const piece of pieces) {
    const entry = sized(piece);
    if (!entry) return null;
    bytes += entry.bytes;
    if (bytes > translationLimits.passageBytes) return null;
  }
  return { pieces: pieces as string[], bytes };
}

export async function translatePassages(source: string, target: string, blocks: string[][], owner: string): Promise<(string[] | null)[]> {
  if (!Array.isArray(blocks)) refuseRequest("the passages weren't a list");
  checkRequest(blocks.length, 0);
  const none = () => blocks.map(() => null);
  if (!owners.has(owner)) return none();
  const out: (string[] | null)[] = none();
  const fresh: { pieces: string[]; bytes: number; i: number }[] = [];
  let refused = 0;
  blocks.forEach((block, i) => {
    const passage = passageOf(block);
    if (!passage) {
      if (Array.isArray(block) && block.length) refused++;
      return;
    }
    const known = memo.get(memoKey(source, target, passage.pieces));
    if (known) out[i] = known;
    else fresh.push({ ...passage, i });
  });
  if (refused) host.count("translate_passages_refused");
  if (!fresh.length) return out;
  const bytes = fresh.reduce((sum, passage) => sum + passage.bytes, 0);
  checkRequest(blocks.length, bytes);
  const models = await modelsFor(source, target);
  if (!owners.has(owner)) return none();
  const texts = fresh.map(({ pieces }) => (pieces.length === 1 ? { text: pieces[0]!, html: false } : { text: piecesHtml(pieces), html: true }));
  let translated: string[];
  try {
    translated = await enqueue(owner, models, texts, bytes);
  } catch (error) {
    if (error instanceof Cancelled || !owners.has(owner)) return none();
    throw error;
  }
  fresh.forEach(({ pieces, i }, k) => {
    const text = translated[k];
    if (typeof text !== "string") return;
    const parts = pieces.length === 1 ? (text.trim() ? [text] : null) : alignedParts(text, pieces);
    if (!parts) return;
    out[i] = parts;
    remember(memoKey(source, target, pieces), parts);
  });
  return owners.has(owner) ? out : none();
}

export function openOwner(owner: string): void {
  if (typeof owner !== "string" || owner === DIRECT) return;
  owners.delete(owner);
  owners.add(owner);
  for (const oldest of owners) {
    if (owners.size <= translationLimits.openOwners) break;
    cancelOwner(oldest);
  }
}

export function cancelOwner(owner: string): void {
  owners.delete(owner);
  const dropped = queue.filter((job) => job.owner === owner);
  if (dropped.length) {
    queue.splice(0, queue.length, ...queue.filter((job) => job.owner !== owner));
    for (const job of dropped) job.reject(new Cancelled("the translation was cancelled"));
  }
  if (running?.job.owner === owner) {
    host.count("translate_cancel_stops");
    stopWorker("the translation was cancelled");
  }
  stopWhenIdle();
}
