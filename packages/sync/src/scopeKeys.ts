import type { ScopeState, SyncRecord } from "./scopeState.ts";

export function visible(state: ScopeState, prefix: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const { records } = state;
  for (const key in records) {
    if (!key.startsWith(prefix)) continue;
    const value = records[key]!.v;
    if (value !== null) out.set(key, value);
  }
  return out;
}

export function recordsWith(state: ScopeState, prefix: string): [string, SyncRecord][] {
  const out: [string, SyncRecord][] = [];
  const { records } = state;
  for (const key in records) if (key.startsWith(prefix)) out.push([key, records[key]!]);
  return out;
}

export type TouchedKeys = { records: Set<string>; base: Set<string> };
const touching = new WeakMap<ScopeState, Set<TouchedKeys>>();

export function trackTouchedKeys(state: ScopeState): { touched: TouchedKeys; stop: () => void } {
  const touched: TouchedKeys = { records: new Set(), base: new Set() };
  let all = touching.get(state);
  if (!all) touching.set(state, (all = new Set()));
  all.add(touched);
  return {
    touched,
    stop: () => {
      all.delete(touched);
      if (!all.size && touching.get(state) === all) touching.delete(state);
    },
  };
}

function touch(state: ScopeState, kind: keyof TouchedKeys, key: string) {
  const all = touching.get(state);
  if (all) for (const touched of all) touched[kind].add(key);
}

export function putRecord(state: ScopeState, key: string, record: SyncRecord) {
  state.records[key] = record;
  touch(state, "records", key);
}

export function dropRecord(state: ScopeState, key: string) {
  if (!(key in state.records)) return;
  delete state.records[key];
  touch(state, "records", key);
}

type BaseIndex = { keys: string[]; byPrefix: Map<string, string[]> };
const baseIndexes = new WeakMap<ScopeState, BaseIndex>();

export function baseKeysWith(state: ScopeState, prefix: string): readonly string[] {
  const index = baseIndexes.get(state);
  if (!index) return Object.keys(state.base).filter((key) => key.startsWith(prefix));
  let keys = index.byPrefix.get(prefix);
  if (!keys) {
    keys = [];
    const all = index.keys;
    for (let i = 0; i < all.length; i++) if (all[i]!.startsWith(prefix)) keys.push(all[i]!);
    index.byPrefix.set(prefix, keys);
  }
  return keys;
}

export function putBase(state: ScopeState, key: string, json: string) {
  const known = state.base[key];
  if (known === json) return;
  const index = known === undefined ? baseIndexes.get(state) : undefined;
  state.base[key] = json;
  touch(state, "base", key);
  if (!index) return;
  index.keys.push(key);
  index.byPrefix.forEach((keys, prefix) => {
    if (key.startsWith(prefix)) keys.push(key);
  });
}

export function dropBase(state: ScopeState, key: string) {
  if (!(key in state.base)) return;
  delete state.base[key];
  touch(state, "base", key);
}

export async function withBaseIndex<T>(state: ScopeState, run: () => Promise<T>): Promise<T> {
  baseIndexes.set(state, { keys: Object.keys(state.base), byPrefix: new Map() });
  try {
    return await run();
  } finally {
    baseIndexes.delete(state);
  }
}
