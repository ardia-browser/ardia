import { readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defineModule } from "../bridge";
import { note } from "../log";
import { dataDirectory } from "../paths";
import { onFinishQuit } from "../quit";
import { replaceFileAtomically, tempSibling } from "../files";

type Waiter = { resolve: () => void; reject: (error: Error) => void };
type Staged = { path: string; generation: number; contents: string; waiters: Waiter[]; landing: boolean };

const staged = new Map<string, Staged>();
const removing = new Map<string, number>();
let generation = 0;
let closed = false;
let chain: Promise<void> = Promise.resolve();

function documentPath(name: string): string | null {
  const last = basename(String(name).replace(/\\/g, "/"));
  if (!last || last === "." || last === ".." || /[\u0000-\u001f]/.test(last)) return null;
  return join(dataDirectory(), last);
}

async function replaceAtomically(path: string, contents: string, stillCurrent: () => boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = tempSibling(path);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (stillCurrent()) renameSync(temp, path);
    else rmSync(temp, { force: true });
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const isCurrent = (key: string, mine: number) => staged.get(key)?.generation === mine;

const serially = (task: () => Promise<void>) => {
  chain = chain.then(task, task);
  return chain;
};

function settle(key: string, mine: number, error: Error | null): void {
  const slot = staged.get(key);
  if (!slot || slot.generation !== mine) return;
  const waiters = slot.waiters;
  slot.waiters = [];
  if (!error) staged.delete(key);
  for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
}

function land(key: string, mine: number, attempt: number): void {
  void serially(async () => {
    const slot = staged.get(key);
    if (!slot || slot.generation !== mine) return;
    slot.landing = true;
    let failure: Error | null = null;
    try {
      await replaceAtomically(slot.path, slot.contents, () => isCurrent(key, mine));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    slot.landing = false;
    settle(key, mine, failure);
    if (!failure) return;
    note("documents", `saving ${key} failed (try ${attempt + 1}): ${failure.message}`);
    const delay = Math.min(60, 2 << Math.min(attempt, 5)) * 1000;
    setTimeout(() => land(key, mine, attempt + 1), delay);
  });
}

export function readDocument(name: string): string | null {
  const path = documentPath(name);
  if (!path) return null;
  const key = basename(path);
  const slot = staged.get(key);
  if (slot) return slot.contents;
  if (removing.has(key)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function stage(name: string, contents: string, waiter?: Waiter): boolean {
  const path = documentPath(name);
  if (!path) {
    waiter?.reject(new Error("Invalid document name"));
    return false;
  }
  if (closed) {
    waiter?.reject(new Error("Documents are closed"));
    return false;
  }
  const key = basename(path);
  removing.delete(key);
  const mine = ++generation;
  const slot = staged.get(key);
  const waiters = slot ? slot.waiters : [];
  if (waiter) waiters.push(waiter);
  staged.set(key, { path, generation: mine, contents: String(contents), waiters, landing: false });
  land(key, mine, 0);
  return true;
}

export function writeDocument(name: string, contents: string): boolean {
  return stage(name, contents);
}

function saveDocument(name: string, contents: string): Promise<void> {
  return new Promise((resolve, reject) => void stage(name, contents, { resolve, reject }));
}

function documentSaved(name: string): Promise<void> {
  const path = documentPath(name);
  if (!path) return Promise.reject(new Error("Invalid document name"));
  const slot = staged.get(basename(path));
  if (!slot) return Promise.resolve();
  return new Promise((resolve, reject) => slot.waiters.push({ resolve, reject }));
}

export function removeDocument(name: string): boolean {
  const path = documentPath(name);
  if (!path || closed) return false;
  const key = basename(path);
  ++generation;
  const slot = staged.get(key);
  staged.delete(key);
  removing.set(key, (removing.get(key) ?? 0) + 1);
  void serially(async () => {
    let failure: Error | null = null;
    try {
      if (removing.has(key)) await rm(path, { force: true });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      note("documents", `a document could not be removed: ${key}: ${failure.message}`);
    }
    const left = (removing.get(key) ?? 1) - 1;
    if (left <= 0) removing.delete(key);
    else removing.set(key, left);
    for (const waiter of slot?.waiters ?? []) failure ? waiter.reject(failure) : waiter.resolve();
  });
  return true;
}

export function flushDocuments(): number {
  closed = true;
  let failed = 0;
  for (const [key, slot] of staged) {
    try {
      replaceFileAtomically(slot.path, slot.contents);
      staged.delete(key);
      for (const waiter of slot.waiters) waiter.resolve();
    } catch (error) {
      failed++;
      note("documents", `saving ${key} at quit failed: ${String(error)}`);
    }
  }
  for (const key of removing.keys()) {
    try {
      rmSync(join(dataDirectory(), key), { force: true });
    } catch {}
  }
  return failed;
}

onFinishQuit(() => void flushDocuments());
process.on("exit", () => {
  if (staged.size) flushDocuments();
});

defineModule("ArdiaDocuments", {
  sync: { readDocument, writeDocument, removeDocument },
  async: { saveDocument, documentSaved },
});
