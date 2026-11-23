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

const baseWrites = new WeakMap<ScopeState, Map<string, number>>();

export function baseWritesUnder(state: ScopeState, prefix: string): number {
  let counts = baseWrites.get(state);
  if (!counts) baseWrites.set(state, (counts = new Map()));
  const count = counts.get(prefix);
  if (count !== undefined) return count;
  counts.set(prefix, 0);
  return 0;
}

function countBaseWrite(state: ScopeState, key: string) {
  baseWrites.get(state)?.forEach((count, prefix, counts) => {
    if (key.startsWith(prefix)) counts.set(prefix, count + 1);
  });
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

type PrefixKeys = { live: Set<string>; listed: string[] | null };
const baseIndexes = new WeakMap<ScopeState, Map<string, PrefixKeys>>();

export function baseKeysWith(state: ScopeState, prefix: string): readonly string[] {
  let byPrefix = baseIndexes.get(state);
  if (!byPrefix) baseIndexes.set(state, (byPrefix = new Map()));
  let keys = byPrefix.get(prefix);
  if (!keys) {
    const live = new Set<string>();
    for (const key in state.base) if (key.startsWith(prefix)) live.add(key);
    byPrefix.set(prefix, (keys = { live, listed: null }));
  }
  return (keys.listed ??= [...keys.live]);
}

export function putBase(state: ScopeState, key: string, json: string) {
  const known = state.base[key];
  if (known === json) return;
  state.base[key] = json;
  touch(state, "base", key);
  countBaseWrite(state, key);
  if (known !== undefined) return;
  baseIndexes.get(state)?.forEach((keys, prefix) => {
    if (!key.startsWith(prefix)) return;
    keys.live.add(key);
    keys.listed = null;
  });
}

export function dropBase(state: ScopeState, key: string) {
  if (!(key in state.base)) return;
  delete state.base[key];
  touch(state, "base", key);
  countBaseWrite(state, key);
  baseIndexes.get(state)?.forEach((keys) => {
    if (keys.live.delete(key)) keys.listed = null;
  });
}
