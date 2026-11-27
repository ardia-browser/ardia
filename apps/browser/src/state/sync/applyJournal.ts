import { emptyScope, validBatches, type ApplyBatch, type ScopeState } from "../../platform/sync";
import { isFields } from "../../lib/decode";
import type { SyncDoc } from "./syncDoc";

type Trimmed = { k?: string[]; e?: string[]; r?: 1; f?: 1; ok?: 1 };
export type ScopeRest = Partial<ScopeState> & { applyingIds?: number[]; applyingTrimmed?: Record<string, Trimmed> };
type Chunk = ApplyBatch & { n: number; i: number };
export type Assembly = Map<string, Map<number, { n: number; chunks: Map<number, ApplyBatch> }>>;

export const APPLYING_PART_CHARS = 1_000_000;

const isIdList = (v: unknown): v is number[] => Array.isArray(v) && v.every((id) => typeof id === "number" && Number.isFinite(id));
const isKeyList = (v: unknown): v is string[] => Array.isArray(v) && v.every((key) => typeof key === "string");
const isTrimmed = (v: unknown): v is Trimmed =>
  isFields(v) && (v.k !== undefined || v.e !== undefined) && (v.k === undefined || isKeyList(v.k)) && (v.e === undefined || isKeyList(v.e)) && (v.r === undefined || v.r === 1) && (v.f === undefined || v.f === 1) && (v.ok === undefined || v.ok === 1);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function batchOnly(batch: ApplyBatch): ApplyBatch {
  const { n: _n, i: _i, ...rest } = batch as Partial<Chunk>;
  return rest as ApplyBatch;
}

export function restOf(state: ScopeState): ScopeRest {
  const { records: _records, base: _base, applying, ...rest } = state;
  if (!applying?.length) return rest;
  const trimmedOf = (b: ApplyBatch): Trimmed => {
    const kept = Object.keys(b.k);
    const cut = b.cut ?? [];
    return { ...(cut.length < kept.length ? { e: cut } : { k: kept }), ...(b.r ? { r: 1 as const } : {}), ...(b.f ? { f: 1 as const } : {}), ...(b.ok ? { ok: 1 as const } : {}) };
  };
  const trimmed = Object.fromEntries(applying.filter((b) => b.cut?.length || b.r || b.f || b.ok).map((b) => [String(b.id), trimmedOf(b)]));
  return { ...rest, applyingIds: applying.map((b) => b.id), ...(Object.keys(trimmed).length ? { applyingTrimmed: trimmed } : {}) };
}

function trimmedTo(batch: ApplyBatch, trim: Trimmed | undefined): ApplyBatch | null {
  if (!trim) return batch;
  const kept = trim.k ? new Set(trim.k) : null;
  const cut = new Set(trim.e ?? []);
  const k = Object.fromEntries(Object.entries(batch.k).filter(([key]) => (kept ? kept.has(key) : !cut.has(key))));
  if (!Object.keys(k).length) return null;
  const allCut = [...new Set([...(batch.cut ?? []), ...Object.keys(batch.k).filter((key) => !(key in k))])];
  return { ...batch, k, ...(allCut.length ? { cut: allCut } : {}), ...(trim.r ? { r: 1 as const } : {}), ...(trim.f ? { f: 1 as const } : {}), ...(trim.ok ? { ok: 1 as const } : {}) };
}

export function scopeFromRest(rest: unknown, records: ScopeState["records"], base: ScopeState["base"], before: ScopeState | undefined): ScopeState {
  const { applying: _applying, applyingIds, applyingTrimmed, ...kept } = (isFields(rest) ? rest : {}) as ScopeRest;
  const scoped: ScopeState = { ...emptyScope(), ...kept, records, base };
  const ids = isIdList(applyingIds) ? new Set(applyingIds) : null;
  const trims = isFields(applyingTrimmed) ? applyingTrimmed : {};
  const batches: ApplyBatch[] = [];
  for (const batch of before?.applying ?? []) {
    if (!ids?.has(batch.id)) continue;
    const trim = trims[String(batch.id)];
    const left = trimmedTo(batch, isTrimmed(trim) ? trim : undefined);
    if (left) batches.push(left);
  }
  if (batches.length) scoped.applying = batches;
  return scoped;
}

export function savedScope(scope: Record<string, unknown>): ScopeState {
  const { applyingIds: _ids, applyingTrimmed: _trimmed, ...saved } = scope;
  const scoped: ScopeState = { ...emptyScope(), ...(saved as Partial<ScopeState>) };
  const batches = validBatches(saved.applying).map(batchOnly);
  if (batches.length) scoped.applying = batches;
  else delete scoped.applying;
  return scoped;
}

function install(scopes: SyncDoc["scopes"], scope: string, batch: ApplyBatch) {
  const scoped = (scopes[scope] ??= emptyScope());
  const known = (scoped.applying ?? []).filter((b) => b.id !== batch.id);
  const batches = Object.keys(batch.k).length ? [...known, batch].sort((a, z) => a.id - z.id) : known;
  if (batches.length) scoped.applying = batches;
  else delete scoped.applying;
}

export function replayApplying(scopes: SyncDoc["scopes"], applying: unknown, live: Set<string>, assembly: Assembly) {
  if (!isFields(applying)) return;
  for (const [scope, list] of Object.entries(applying)) {
    if (!live.has(scope) || !Array.isArray(list)) continue;
    for (const chunk of validBatches(list) as Partial<Chunk>[]) {
      const n = isCount(chunk.n) ? chunk.n : 1;
      const i = chunk.i === undefined && chunk.n === undefined ? 0 : typeof chunk.i === "number" && Number.isSafeInteger(chunk.i) && chunk.i >= 0 && chunk.i < n ? chunk.i : -1;
      if (i < 0) continue;
      let byId = assembly.get(scope);
      if (!byId) assembly.set(scope, (byId = new Map()));
      const id = chunk.id!;
      let pending = byId.get(id);
      if (!pending || pending.n !== n) byId.set(id, (pending = { n, chunks: new Map() }));
      pending.chunks.set(i, batchOnly(chunk as ApplyBatch));
      if (pending.chunks.size < n) continue;
      byId.delete(id);
      const parts = [...pending.chunks.values()];
      install(scopes, scope, { ...parts[0]!, k: Object.assign({}, ...parts.map((p) => p.k)) });
    }
  }
}

export function chunksOf(batch: ApplyBatch, limit = APPLYING_PART_CHARS): Chunk[] {
  const groups: ApplyBatch["k"][] = [];
  let keys: ApplyBatch["k"] = {};
  let size = 0;
  for (const [key, step] of Object.entries(batch.k)) {
    const entry = JSON.stringify(key).length + JSON.stringify(step).length + 2;
    if (size && size + entry > limit) {
      groups.push(keys);
      keys = {};
      size = 0;
    }
    keys[key] = step;
    size += entry;
  }
  groups.push(keys);
  return groups.map((k, i) => ({ ...batch, k, n: groups.length, i }));
}

export const holdsApplying = (scopes: SyncDoc["scopes"]) => Object.values(scopes).some((scoped) => scoped.applying?.some((b) => !b.r));
