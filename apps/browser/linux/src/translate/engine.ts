import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { count } from "../counts";
import { note } from "../log";
import { filesOf, pairKey, route } from "./models";
import { alignedParts, piecesHtml } from "./pieces";
import type { WorkerReply, WorkerRequest } from "./worker";

const IDLE_MS = 60_000;
const LOADED_LIMIT = 4;
const MEMO_LIMIT = 5000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

let worker: Worker | null = null;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();
const loaded: string[] = [];
const owners = new Set<string>();
const memo = new Map<string, string[]>();

function stopWorker(reason: string) {
  const stopping = worker;
  worker = null;
  loaded.length = 0;
  for (const waiter of pending.values()) waiter.reject(new Error(reason));
  pending.clear();
  void stopping?.terminate();
}

function startWorker(): Worker {
  const unpacked = __dirname.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked");
  const bergamot = join(unpacked, "bergamot");
  const started = new Worker(join(unpacked, "translateWorker.js"), {
    workerData: { wasm: join(bergamot, "bergamot-translator-worker.wasm"), glue: join(bergamot, "bergamot-translator-worker.js") },
  });
  started.on("message", ({ id, result, error }: WorkerReply) => {
    const waiter = pending.get(id);
    pending.delete(id);
    if (error !== undefined) waiter?.reject(new Error(error));
    else waiter?.resolve(result);
  });
  started.on("error", (error) => {
    count("translate_engine_failures");
    note("translate", `the engine failed: ${error.message}`);
    if (worker === started) stopWorker("the translation engine stopped");
  });
  started.on("exit", () => {
    if (worker === started) stopWorker("the translation engine stopped");
  });
  started.unref();
  return started;
}

function stopWhenIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => (pending.size ? stopWhenIdle() : stopWorker("idle")), IDLE_MS);
}

function send<T>(request: Request): Promise<T> {
  worker ??= startWorker();
  stopWhenIdle();
  const id = ++nextId;
  const sent = new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
  worker.postMessage({ ...request, id });
  return sent;
}

async function ensureLoaded(pair: string) {
  const at = loaded.indexOf(pair);
  if (at >= 0) {
    loaded.splice(at, 1);
    loaded.push(pair);
    return;
  }
  const files = filesOf(pair);
  if (!files) throw new Error(`the ${pair.replace(">", " to ")} language files aren't downloaded`);
  await send({ op: "load", key: pair, files });
  loaded.push(pair);
  while (loaded.length > LOADED_LIMIT) void send({ op: "free", key: loaded.shift()! });
}

async function modelsFor(source: string, target: string): Promise<string[]> {
  const pairs = route(source, target);
  if (!pairs) throw new Error(`${source} to ${target} isn't available`);
  for (const pair of pairs) await ensureLoaded(pair);
  return pairs;
}

export async function translateTexts(source: string, target: string, texts: string[]): Promise<(string | null)[]> {
  if (!texts.length) return [];
  const models = await modelsFor(source, target);
  return send<string[]>({ op: "translate", models, texts: texts.map((text) => ({ text, html: false })) });
}

const memoKey = (source: string, target: string, pieces: string[]) => `${pairKey(source, target)}\u0000${pieces.join("\u0001")}`;

function remember(key: string, parts: string[]) {
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, parts);
}

export async function translatePassages(source: string, target: string, blocks: string[][], owner: string): Promise<(string[] | null)[]> {
  if (!owners.has(owner)) return blocks.map(() => null);
  const out: (string[] | null)[] = blocks.map((pieces) => memo.get(memoKey(source, target, pieces)) ?? null);
  const fresh = blocks.map((pieces, i) => ({ pieces, i })).filter(({ pieces, i }) => !out[i] && pieces.length > 0);
  if (!fresh.length) return out;
  const models = await modelsFor(source, target);
  if (!owners.has(owner)) return blocks.map(() => null);
  const texts = fresh.map(({ pieces }) => (pieces.length === 1 ? { text: pieces[0]!, html: false } : { text: piecesHtml(pieces), html: true }));
  const translated = await send<string[]>({ op: "translate", models, texts });
  fresh.forEach(({ pieces, i }, k) => {
    const text = translated[k];
    if (typeof text !== "string") return;
    const parts = pieces.length === 1 ? (text.trim() ? [text] : null) : alignedParts(text, pieces);
    if (!parts) return;
    out[i] = parts;
    remember(memoKey(source, target, pieces), parts);
  });
  return owners.has(owner) ? out : blocks.map(() => null);
}

export const openOwner = (owner: string) => void owners.add(owner);
export const cancelOwner = (owner: string) => void owners.delete(owner);
