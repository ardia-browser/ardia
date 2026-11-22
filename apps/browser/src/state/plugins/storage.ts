import { isFields } from "../../lib/decode";
import { readStorageText, writeStorageText } from "./hostIo";

export const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
export const STORAGE_LIMITS = { key: 128, keys: 1000, valueBytes: 256 * 1024, totalBytes: MAX_STORAGE_BYTES } as const;

const STORAGE_KEY = /^[\x21-\x7e]{1,128}$/;

type Data = Record<string, unknown>;
export type StorageOutcome<T> = { ok: true; value: T } | { ok: false; code: "bad_request" | "failed"; message: string; closed?: true };
export type StorageLookup = { found: true; value: unknown } | { found: false };
type Loaded = { ok: true; data: Data } | { ok: false; message: string };

const loaded = new Map<string, Data>();
const queues = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();
const epochs = new Map<string, number>();
const closed = new Set<string>();

const CLOSED_MESSAGE = "The plugin is being removed, so its storage is closed.";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const fail = <T,>(code: "bad_request" | "failed", message: string): StorageOutcome<T> => ({ ok: false, code, message });

const epochOf = (name: string) => epochs.get(name) ?? 0;
const isOpen = (name: string, epoch: number) => !closed.has(name) && epochOf(name) === epoch;

const cancelled = <T,>(): StorageOutcome<T> => ({ ok: false, code: "failed", message: CLOSED_MESSAGE, closed: true });

function queued<T>(name: string, work: (epoch: number) => Promise<StorageOutcome<T>>): Promise<StorageOutcome<T>> {
  if (closed.has(name)) return Promise.resolve(cancelled<T>());
  const epoch = epochOf(name);
  const guarded = () => (isOpen(name, epoch) ? work(epoch) : Promise.resolve(cancelled<T>()));
  const run = (queues.get(name) ?? Promise.resolve()).then(guarded, guarded);
  queues.set(name, run.catch(() => {}));
  return run;
}

function parsedStorage(text: string): Loaded {
  try {
    const parsed: unknown = JSON.parse(text);
    return isFields(parsed) ? { ok: true, data: parsed } : { ok: false, message: "The plugin's storage file isn't a JSON object, so Ardia leaves it alone." };
  } catch {
    return { ok: false, message: "The plugin's storage file isn't valid JSON, so Ardia leaves it alone." };
  }
}

async function dataOf(name: string): Promise<Loaded> {
  const cached = loaded.get(name);
  if (cached) return { ok: true, data: cached };
  const generation = generations.get(name) ?? 0;
  const read = await readStorageText(name);
  const result: Loaded = read.status === "missing" ? { ok: true, data: {} } : read.status === "ok" ? parsedStorage(read.text) : { ok: false, message: `The plugin's storage couldn't be read: ${read.reason}` };
  if (result.ok && (generations.get(name) ?? 0) === generation) loaded.set(name, result.data);
  return result;
}

function withData<T>(name: string, use: (data: Data, epoch: number) => StorageOutcome<T> | Promise<StorageOutcome<T>>): Promise<StorageOutcome<T>> {
  return queued(name, async (epoch) => {
    const read = await dataOf(name);
    if (!isOpen(name, epoch)) return cancelled<T>();
    return read.ok ? use(read.data, epoch) : fail<T>("failed", read.message);
  });
}

export const isStorageKey = (key: unknown): key is string => typeof key === "string" && STORAGE_KEY.test(key);

export function storageGet(name: string, key: unknown): Promise<StorageOutcome<StorageLookup>> {
  if (!isStorageKey(key)) return Promise.resolve(fail("bad_request", `key is 1 to ${STORAGE_LIMITS.key} printable ASCII characters.`));
  return withData(name, (data) => ({ ok: true, value: Object.hasOwn(data, key) ? { found: true, value: data[key] } : { found: false } }));
}

export function storageKeys(name: string): Promise<StorageOutcome<string[]>> {
  return withData(name, (data) => ({ ok: true, value: Object.keys(data) }));
}

async function save(name: string, next: Data, epoch: number): Promise<StorageOutcome<true>> {
  const text = JSON.stringify(next);
  if (bytes(text) > STORAGE_LIMITS.totalBytes) return fail("bad_request", `The plugin's storage would be over ${STORAGE_LIMITS.totalBytes / 1024 / 1024} MB.`);
  if (!isOpen(name, epoch)) return cancelled();
  const generation = generations.get(name) ?? 0;
  const written = await writeStorageText(name, text);
  if (!written.ok) return fail("failed", written.reason ?? "The plugin's storage couldn't be saved.");
  if ((generations.get(name) ?? 0) === generation) loaded.set(name, next);
  return { ok: true, value: true };
}

export function storageSet(name: string, key: unknown, value: unknown): Promise<StorageOutcome<true>> {
  if (!isStorageKey(key)) return Promise.resolve(fail("bad_request", `key is 1 to ${STORAGE_LIMITS.key} printable ASCII characters.`));
  let text: string | undefined;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = undefined;
  }
  if (text === undefined) return Promise.resolve(fail("bad_request", "value must be JSON."));
  if (bytes(text) > STORAGE_LIMITS.valueBytes) return Promise.resolve(fail("bad_request", `value is over ${STORAGE_LIMITS.valueBytes / 1024} KB.`));
  const copy = JSON.parse(text) as unknown;
  return withData(name, (data, epoch) => {
    if (!Object.hasOwn(data, key) && Object.keys(data).length >= STORAGE_LIMITS.keys) return fail<true>("bad_request", `The plugin's storage holds at most ${STORAGE_LIMITS.keys} keys.`);
    return save(name, { ...data, [key]: copy }, epoch);
  });
}

export function storageDelete(name: string, key: unknown): Promise<StorageOutcome<true>> {
  if (!isStorageKey(key)) return Promise.resolve(fail("bad_request", `key is 1 to ${STORAGE_LIMITS.key} printable ASCII characters.`));
  return withData(name, (data, epoch) => {
    if (!Object.hasOwn(data, key)) return { ok: true, value: true };
    const { [key]: _gone, ...rest } = data;
    return save(name, rest, epoch);
  });
}

export function dropPluginStorage(name: string) {
  loaded.delete(name);
  generations.set(name, (generations.get(name) ?? 0) + 1);
}

export const wipePluginStorage = (name: string): Promise<StorageOutcome<true>> =>
  queued(name, async (epoch) => {
    dropPluginStorage(name);
    return save(name, {}, epoch);
  });

export async function closePluginStorage(name: string): Promise<void> {
  closed.add(name);
  epochs.set(name, epochOf(name) + 1);
  dropPluginStorage(name);
  await queues.get(name);
}

export function reopenPluginStorage(name: string) {
  if (!closed.delete(name)) return;
  dropPluginStorage(name);
}
