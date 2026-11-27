import { canonical } from "./canon.ts";
import { visible } from "./scopeKeys.ts";
import type { ApplyBatch, ScopeOptions, ScopeState } from "./scopeState.ts";

export const ABSENT = "null";
const NATIVE_SAVE_MS = 30_000;
export const UNSEEN_KEPT_MS = 86_400_000;

const thisLaunch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const steadyNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const launchOf = (options: ScopeOptions = {}) => options.launch ?? thisLaunch;
const monotonicOf = (options: ScopeOptions = {}) => (options.monotonic ?? steadyNow)();

function isJsonOrNull(v: unknown) {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}
const isStep = (v: unknown) => Array.isArray(v) && v.length === 2 && isJsonOrNull(v[0]) && isJsonOrNull(v[1]);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isApplyBatch(v: unknown): v is ApplyBatch {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  if (!isFiniteNumber(b.id) || typeof b.p !== "string" || typeof b.l !== "string" || !isFiniteNumber(b.at)) return false;
  if (b.done !== undefined && !isFiniteNumber(b.done)) return false;
  if ([b.r, b.f, b.ok].some((flag) => flag !== undefined && flag !== 1)) return false;
  if (b.cut !== undefined && !(Array.isArray(b.cut) && b.cut.every((key) => typeof key === "string"))) return false;
  return typeof b.k === "object" && b.k !== null && !Array.isArray(b.k) && Object.values(b.k).every(isStep);
}

export const validBatches = (v: unknown): ApplyBatch[] => (Array.isArray(v) ? v.filter(isApplyBatch) : []);

function noteBatch(state: ScopeState, prefix: string, keys: Iterable<string>, now: number, options: ScopeOptions): ApplyBatch | null {
  const view = visible(state, prefix);
  const k: ApplyBatch["k"] = {};
  let noted = false;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const from = state.base[key];
    const to = view.has(key) ? canonical(view.get(key)) : ABSENT;
    if ((from ?? ABSENT) === to && !awaitsRecovery(state, key)) continue;
    k[key] = [from ?? null, to === ABSENT ? null : to];
    noted = true;
  }
  if (!noted) return null;
  const batches = (state.applying ??= []);
  const id = Math.max(now, ...batches.map((b) => b.id + 1));
  const batch: ApplyBatch = { id, p: prefix, l: launchOf(options), at: now, k };
  batches.push(batch);
  return batch;
}

function dropBatch(state: ScopeState, batch: ApplyBatch) {
  state.applying = state.applying?.filter((b) => b !== batch);
  if (!state.applying?.length) delete state.applying;
}

export type WriteAhead = { batch: ApplyBatch | null; failed: boolean };

export async function writeAhead(state: ScopeState, prefix: string, keys: Iterable<string>, now: number, options: ScopeOptions = {}): Promise<WriteAhead> {
  const persist = options.persistApplying;
  const batch = persist ? noteBatch(state, prefix, keys, now, options) : null;
  if (!persist || !batch) return { batch: null, failed: false };
  try {
    await persist(batch);
    return { batch, failed: false };
  } catch (error) {
    console.warn(`[sync] couldn't journal what ${prefix} is about to apply`, error);
    dropBatch(state, batch);
    return { batch: null, failed: true };
  }
}

const owedRetirements = new WeakMap<ScopeState, ApplyBatch[]>();

async function retire(state: ScopeState, batch: ApplyBatch, options: ScopeOptions) {
  try {
    await options.persistApplying?.({ ...batch, k: {} });
  } catch (error) {
    owedRetirements.set(state, [...(owedRetirements.get(state) ?? []).filter((b) => b.id !== batch.id), batch]);
    throw error;
  }
}

export async function cancelIfRaced(state: ScopeState, batch: ApplyBatch | null, raced: Set<string>, options: ScopeOptions = {}): Promise<boolean> {
  if (!batch || !Object.keys(batch.k).some((key) => raced.has(key))) return false;
  dropBatch(state, batch);
  await retire(state, batch, options);
  return true;
}

export async function settleOwedRetirements(state: ScopeState, options: ScopeOptions = {}) {
  const owed = owedRetirements.get(state);
  if (!owed?.length) return;
  owedRetirements.delete(state);
  for (const batch of owed) await retire(state, batch, options);
}

export function finishBatch(batch: ApplyBatch | null, applied: boolean, options: ScopeOptions = {}) {
  if (!batch) return;
  batch.done = monotonicOf(options);
  if (applied) batch.ok = 1;
  else batch.f = 1;
}

export function startApplying(state: ScopeState, now: number, options: ScopeOptions = {}) {
  takeReapplied(state);
  if (!state.applying) return;
  const launch = launchOf(options);
  const steady = monotonicOf(options);
  const saveMs = options.nativeSaveMs ?? NATIVE_SAVE_MS;
  const retrying = new Set(state.unapplied);
  const live = (b: ApplyBatch) => {
    if (b.l === launch && b.f && Object.keys(b.k).some((key) => retrying.has(key))) return true;
    if (b.l === launch) return b.done === undefined || steady - b.done < saveMs;
    return !b.r || now - b.at < UNSEEN_KEPT_MS;
  };
  state.applying = state.applying.filter(live);
  if (!state.applying.length) delete state.applying;
}

type Recovering = { pending: Set<string> };
const recovering = new WeakMap<ScopeState, Recovering>();
const reapplied = new WeakMap<ScopeState, number>();

export function queueRecovered(state: ScopeState, keys: string[]) {
  if (!keys.length) return;
  const queued = new Set(state.unapplied);
  let marks = recovering.get(state);
  if (!marks) recovering.set(state, (marks = { pending: new Set() }));
  for (const key of keys) {
    marks.pending.add(key);
    if (queued.has(key)) continue;
    queued.add(key);
    state.unapplied.push(key);
  }
}

export const awaitsRecovery = (state: ScopeState, key: string) => !!recovering.get(state)?.pending.has(key);

export function countReapplied(state: ScopeState, applied: Iterable<string>, deferred: Set<string>, changed: Set<string>) {
  const marks = recovering.get(state);
  if (!marks?.pending.size) return;
  let count = 0;
  for (const key of applied) {
    if (deferred.has(key) || !marks.pending.delete(key)) continue;
    if (changed.has(key)) count++;
  }
  if (count) reapplied.set(state, (reapplied.get(state) ?? 0) + count);
}

export function failedTargets(state: ScopeState, prefix: string, options: ScopeOptions = {}): Map<string, Set<string>> | null {
  const launch = launchOf(options);
  let targets: Map<string, Set<string>> | null = null;
  for (const batch of state.applying ?? []) {
    if (!batch.f || batch.l !== launch || batch.p !== prefix) continue;
    targets ??= new Map();
    for (const [key, [, to]] of Object.entries(batch.k)) {
      let held = targets.get(key);
      if (!held) targets.set(key, (held = new Set()));
      held.add(to ?? ABSENT);
    }
  }
  return targets;
}

export function takeReapplied(state: ScopeState): number {
  const count = reapplied.get(state) ?? 0;
  reapplied.delete(state);
  return count;
}
