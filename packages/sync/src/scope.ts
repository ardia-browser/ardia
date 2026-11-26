import { canonical } from "./canon.ts";
import { hlcWall, type Clock, type HLC } from "./hlc.ts";
import { holdsBack, noteFileHealth } from "./fileHealth.ts";
import { baseKeysWith, baseWritesUnder, dropBase, dropRecord, putBase, putRecord, visible } from "./scopeKeys.ts";
export * from "./scopeKeys.ts";
import { covered, isApplied, markApplied, raiseApplied } from "./applied.ts";
import { awaitsRecovery, cancelIfRaced, countReapplied, failedTargets, finishBatch, settleOwedRetirements, startApplying, takeReapplied, writeAhead, type WriteAhead } from "./applyBatches.ts";
import { recoverBatches } from "./applyRecovery.ts";
import { parseSyncFile } from "./syncFile.ts";
import { DEFAULTS, newestSnapshot, prune, retiredBy, compactionDue } from "./compaction.ts";
export { compactionDue } from "./compaction.ts";
export { parseSyncFile } from "./syncFile.ts";
import type { Adapter, LogFile, ScopeOptions, ScopeState, SnapshotFile, SyncFile, SyncRecord, Transport } from "./scopeState.ts";


function see(state: ScopeState, device: string, at: number) {
  if (!(device in state.seen) || at > state.seen[device]!) state.seen[device] = at;
}

function mergeRecord(state: ScopeState, key: string, record: SyncRecord, clock: Clock): boolean {
  clock.observe(record.h);
  const current = state.records[key];
  if (current && current.h >= record.h) return false;
  putRecord(state, key, record);
  return true;
}

function ingestLog(state: ScopeState, file: LogFile, clock: Clock, changed: Set<string>) {
  see(state, file.device, file.at);
  if (isApplied(state, [file.device, file.seq])) return;
  for (const op of file.ops) {
    if (mergeRecord(state, op.k, { h: op.h, v: op.v, o: [file.device, file.seq] }, clock)) changed.add(op.k);
  }
  markApplied(state, file.device, file.seq);
}

export function ingestSnapshot(state: ScopeState, file: SnapshotFile, clock: Clock, changed: Set<string>) {
  for (const [device, at] of Object.entries(file.seen)) see(state, device, at);
  see(state, file.device, file.at);
  for (const [key, record] of Object.entries(file.records)) {
    if (!(key in state.records) && isApplied(state, record.o)) continue;
    if (mergeRecord(state, key, record, clock)) changed.add(key);
  }
  for (const key in state.records) {
    if (!(key in file.records) && covered(file.vv, state.records[key]!.o)) {
      dropRecord(state, key);
      changed.add(key);
    }
  }
  for (const [device, seq] of Object.entries(file.vv)) raiseApplied(state, device, seq);
}

const parseBase = (json: string | undefined) => (json === undefined ? undefined : (JSON.parse(json) as unknown));

const settling = new WeakMap<ScopeState, (() => void)[]>();

function settleWhenDurable(state: ScopeState, settle: () => void) {
  const queue = settling.get(state);
  if (queue) queue.push(settle);
  else settling.set(state, [settle]);
}

function settleDurable(state: ScopeState) {
  const queue = settling.get(state);
  if (!queue) return;
  settling.delete(state);
  for (const settle of queue) settle();
}

type Change = { key: string; value: unknown; json: string };
type Stamps = Map<string, { json: string; h: HLC }>;

type Extracted = { source: object; baseWrites: number; joined: boolean };
const extractedFrom = new WeakMap<ScopeState, Map<string, Extracted>>();

function unchangedSinceExtracted(state: ScopeState, adapter: Adapter, source: object | undefined) {
  const last = source && extractedFrom.get(state)?.get(adapter.prefix);
  return !!last && last.source === source && last.joined === state.joined && last.baseWrites === baseWritesUnder(state, adapter.prefix);
}

function noteExtracted(state: ScopeState, adapter: Adapter, source: object | undefined) {
  if (!source) return;
  let byPrefix = extractedFrom.get(state);
  if (!byPrefix) extractedFrom.set(state, (byPrefix = new Map()));
  byPrefix.set(adapter.prefix, { source, baseWrites: baseWritesUnder(state, adapter.prefix), joined: state.joined });
}

async function changesOf(state: ScopeState, adapter: Adapter, now: number, options: ScopeOptions = {}) {
  if (adapter.adoptRemoteOnJoin && !state.joined) return null;
  const source = adapter.extractsOnlyFrom?.();
  if (unchangedSinceExtracted(state, adapter, source)) return { changes: [], settle: undefined, source: undefined };
  let pending: Set<string> | null = null;
  const queued = (key: string) => (pending ??= new Set([...state.outbox, ...(state.journal ?? []).flatMap((f) => f.ops)].map((op) => op.k))).has(key);
  const extractWith = (baseJson: (key: string) => string | undefined) =>
    Promise.resolve(adapter.extract((key) => parseBase(baseJson(key)), queued, now, (key) => key in state.records, (key) => state.records[key]?.v, (key) => state.records[key]?.h, baseJson));
  const first = await extractWith((key) => state.base[key]);
  const extraction = first && state.applying ? await recoverBatches(state, adapter.prefix, first, adapter.extractUsesBase ? extractWith : null, !!adapter.savesWhole, options) : first;
  if (!extraction) return null;
  const changes: Change[] = [];
  const { values, json: knownJson, republish, ignore } = extraction;
  const unsettled = failedTargets(state, adapter.prefix, options);
  values.forEach((value, key) => {
    if (value === null || value === undefined) throw new Error(`[sync] ${key}: a live value can't be null`);
    const json = knownJson?.(key, value) ?? canonical(value);
    if (unsettled?.get(key)?.has(json)) return;
    if (state.base[key] === json && (!republish?.(key) || awaitsRecovery(state, key))) return;
    changes.push({ key, value, json });
  });
  const keys = baseKeysWith(state, adapter.prefix);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (!(key in state.base) || values.has(key) || ignore?.(key) || unsettled?.get(key)?.has("null")) continue;
    changes.push({ key, value: null, json: "null" });
  }
  return { changes, settle: extraction.published, source };
}

function stampOf(state: ScopeState, adapter: Adapter, clock: Clock, { key, value }: Change): HLC {
  const editedAt = !state.records[key] && value !== null ? adapter.editedAt?.(value) : undefined;
  return editedAt !== undefined ? clock.at(editedAt) : clock.tick();
}

async function candidateStamps(state: ScopeState, adapter: Adapter, clock: Clock, now: number, options?: ScopeOptions): Promise<Stamps> {
  const found = await changesOf(state, adapter, now, options);
  return new Map((found?.changes ?? []).map((change) => [change.key, { json: change.json, h: stampOf(state, adapter, clock, change) }]));
}

async function publishAdapter(state: ScopeState, adapter: Adapter, clock: Clock, device: string, now: number, options: ScopeOptions | undefined, stamps?: Stamps): Promise<Set<string>> {
  const published = new Set<string>();
  const found = await changesOf(state, adapter, now, options);
  if (!found) return published;
  for (const change of found.changes) {
    const { key, value, json } = change;
    if (value === null) dropBase(state, key);
    else putBase(state, key, json);
    const candidate = stamps?.get(key);
    const h = candidate?.json === json ? candidate.h : stampOf(state, adapter, clock, change);
    const known = state.records[key];
    if (known && known.h >= h) continue;
    putRecord(state, key, { h, v: value, o: [device, state.seq + 1] });
    state.outbox.push({ k: key, h, v: value });
    published.add(key);
  }
  noteExtracted(state, adapter, found.source);
  const { settle } = found;
  if (settle && published.size) settleWhenDurable(state, () => settle(published));
  return published;
}

export async function flush(state: ScopeState, transport: Transport, scope: string, device: string, now: number, options: ScopeOptions = {}) {
  if (state.outbox.length) {
    state.seq++;
    (state.journal ??= []).push({ v: 1, kind: "log", device, seq: state.seq, at: now, ops: state.outbox });
    state.outbox = [];
  }
  if (!state.journal?.length) return;
  if (options.persist) {
    await options.persist(state.journal);
    settleDurable(state);
  }
  while (state.journal.length) {
    const file = state.journal[0]!;
    const payload = JSON.stringify(file);
    const id = await transport.write(scope, payload);
    state.files[id] = { d: file.device, k: "log", s: file.seq, at: file.at, b: payload.length };
    state.journal.shift();
    markApplied(state, file.device, file.seq);
    see(state, file.device, now);
  }
  delete state.journal;
  settleDurable(state);
}

export function restoreJournal(state: ScopeState, batches: LogFile[], clock: Clock, written = 0) {
  const saved = state.seq;
  for (const file of [...batches].sort((a, b) => a.seq - b.seq)) {
    if (file.seq <= state.seq) continue;
    if (file.seq === saved + 1) state.outbox = [];
    for (const op of file.ops) {
      mergeRecord(state, op.k, { h: op.h, v: op.v, o: [file.device, file.seq] }, clock);
      if (op.v === null) dropBase(state, op.k);
      else putBase(state, op.k, canonical(op.v));
    }
    state.seq = file.seq;
    if (file.seq <= written) markApplied(state, file.device, file.seq);
    else (state.journal ??= []).push(file);
  }
  state.seq = Math.max(state.seq, written);
}

export const writtenSeq = (state: ScopeState) => state.seq - (state.journal?.length ?? 0);

export async function pull(state: ScopeState, transport: Transport, scope: string, clock: Clock, now: number, options: ScopeOptions = {}) {
  const { damagedGiveUp } = { ...DEFAULTS, ...options };
  const listing = await transport.read(scope, Object.keys(state.files).filter((id) => state.files[id]!.k !== "bad"));
  const changed = new Set<string>();
  const parsed: { id: string; file: SyncFile; b: number }[] = [];
  const unreadable = listing.damaged.map(({ id }) => id);
  for (const { id, payload } of listing.files) {
    const file = parseSyncFile(payload);
    if (file) parsed.push({ id, file, b: payload.length });
    else unreadable.push(id);
  }
  parsed.sort((a, b) => (a.file.kind === b.file.kind ? 0 : a.file.kind === "snapshot" ? -1 : 1));
  for (const { id, file, b } of parsed) {
    if (file.kind === "snapshot") {
      ingestSnapshot(state, file, clock, changed);
      state.files[id] = { d: file.device, k: "snapshot", vv: file.vv, at: file.at, b };
    } else {
      ingestLog(state, file, clock, changed);
      state.files[id] = { d: file.device, k: "log", s: file.seq, at: file.at, b };
    }
  }
  const present = new Set(listing.present);
  for (const id of Object.keys(state.files)) if (!present.has(id)) delete state.files[id];
  noteFileHealth(state, { read: parsed.map(({ id }) => id), unreadable, pending: listing.pending, present }, now, damagedGiveUp);
  return changed;
}

async function applyAdapter(state: ScopeState, adapter: Adapter, keys: Set<string>, now: number, horizon: number, held: () => boolean, deferred: Set<string>): Promise<boolean> {
  const mine = new Set([...keys].filter((k) => k.startsWith(adapter.prefix)));
  if (!mine.size) return true;
  const view = visible(state, adapter.prefix);
  const applyAs = (state.applyAs ??= {});
  applyAs[adapter.prefix] ??= state.joined ? "joined" : "joining";
  const settle = (key: string) => {
    if (view.has(key)) putBase(state, key, canonical(view.get(key)));
    else dropBase(state, key);
  };
  const landed = new Set<string>();
  const changing = new Set([...mine].filter((key) => (state.base[key] ?? "null") !== (view.has(key) ? canonical(view.get(key)) : "null")));
  let ok: boolean | void = false;
  try {
    const records = {
      known: (key: string) => key in state.records,
      now,
      horizon,
      joined: applyAs[adapter.prefix] === "joined",
      held,
      landed: (key: string) => void landed.add(key),
      defer: (key: string) => void (mine.has(key) && deferred.add(key)),
    };
    ok = held() ? false : await adapter.apply(view, mine, (key) => parseBase(state.base[key]), records);
  } catch (error) {
    console.warn(`[sync] applying ${adapter.prefix} failed`, error);
  }
  if (ok === false || held()) {
    for (const key of landed) {
      if (!mine.has(key)) continue;
      settle(key);
      keys.delete(key);
    }
    countReapplied(state, [...landed].filter((key) => mine.has(key)), deferred, changing);
    return false;
  }
  applyAs[adapter.prefix] = "joined";
  for (const key of mine) if (!deferred.has(key)) settle(key);
  countReapplied(state, mine, deferred, changing);
  return true;
}

export async function compact(state: ScopeState, transport: Transport, scope: string, device: string, now: number, options: ScopeOptions = {}, force = false) {
  const o = { ...DEFAULTS, ...options };
  if (!force && !compactionDue(state, now, o)) {
    const own = newestSnapshot(Object.entries(state.files), device);
    if (own) await prune(state, transport, scope, retiredBy(Object.entries(state.files), own[0], own[1].vv ?? {}, now, o.pruneGrace, "logs")).catch((error) => console.warn("[sync] removing covered files failed", error));
    return false;
  }
  await flush(state, transport, scope, device, now, options);
  const records: Record<string, SyncRecord> = {};
  const tombstoneTTL = Object.keys(state.extra).length ? 2 * o.tombstoneTTL : o.tombstoneTTL;
  for (const [key, record] of Object.entries(state.records)) {
    const drop = record.v === null ? now - hlcWall(record.h) > tombstoneTTL : o.expired(key, record.v, now);
    if (drop) dropRecord(state, key);
    else records[key] = record;
  }
  const vv = { ...state.vv };
  const file: SnapshotFile = { v: 1, kind: "snapshot", device, at: now, vv, seen: { ...state.seen }, records };
  const payload = JSON.stringify(file);
  const id = await transport.write(scope, payload);
  state.files[id] = { d: device, k: "snapshot", vv, at: now, b: payload.length };
  state.snapshotAt = now;
  await prune(state, transport, scope, retiredBy(Object.entries(state.files), id, vv, now, o.pruneGrace, "logsAndSnapshots"));
  return true;
}

type CycleResult = { published: number; changed: number; pending: number; compacted: boolean; snapshotBytes: number; reapplied: number };

export async function syncScope(args: {
  scope: string;
  state: ScopeState;
  transport: Transport;
  adapters: Adapter[];
  clock: Clock;
  device: string;
  now?: () => number;
  options?: ScopeOptions;
}): Promise<CycleResult> {
  const { scope, state, transport, adapters, clock, device, options } = args;
  const now = args.now ?? Date.now;
  startApplying(state, now(), options);
  await settleOwedRetirements(state, options);
  let published = 0;
  const stamps = new Map<Adapter, Stamps>();
  for (const adapter of adapters) {
    if (adapter.publishAfterPull) stamps.set(adapter, await candidateStamps(state, adapter, clock, now(), options));
    else published += (await publishAdapter(state, adapter, clock, device, now(), options)).size;
  }
  await flush(state, transport, scope, device, now(), options);
  const changed = await pull(state, transport, scope, clock, now(), options);
  const held = holdsBack(state, now(), options?.damagedGiveUp ?? DEFAULTS.damagedGiveUp);
  const keys = new Set([...state.unapplied, ...changed]);
  const unapplied: string[] = [];
  let heldApply = false;
  let journalFailed = false;
  const applyHeld = () => !!options?.holdApply?.();
  for (const adapter of adapters) {
    const publishLate = async () => {
      const late = adapter.publishAfterPull && held ? new Set<string>() : await publishAdapter(state, adapter, clock, device, now(), options, stamps.get(adapter));
      published += late.size;
      for (const key of late) keys.delete(key);
      return late;
    };
    const late = await publishLate();
    for (const key of state.unapplied) if (key.startsWith(adapter.prefix) && !late.has(key)) keys.add(key);
    heldApply ||= applyHeld();
    const deferred = new Set<string>();
    const ahead: WriteAhead | null = heldApply ? null : await writeAhead(state, adapter.prefix, keys, now(), options);
    const cancelled = !!ahead?.batch && (await cancelIfRaced(state, ahead.batch, await publishLate(), options));
    journalFailed ||= !!ahead?.failed;
    heldApply ||= !!ahead?.failed;
    const applied = !heldApply && !cancelled && (await applyAdapter(state, adapter, keys, now(), 2 * (options?.tombstoneTTL ?? DEFAULTS.tombstoneTTL), applyHeld, deferred));
    finishBatch(ahead?.batch ?? null, applied, options);
    heldApply ||= applyHeld();
    if (!applied) for (const key of keys) if (key.startsWith(adapter.prefix)) unapplied.push(key);
    if (applied) for (const key of deferred) unapplied.push(key);
  }
  state.unapplied = [...unapplied, ...[...keys].filter((k) => !adapters.some((a) => k.startsWith(a.prefix)))];
  if (!heldApply && (!state.awaitRemote || Object.keys(state.seen).some((d) => d !== device))) {
    state.joined = true;
    delete state.awaitRemote;
  }
  await flush(state, transport, scope, device, now(), options);
  if (journalFailed) throw new Error("[sync] couldn't journal what this cycle was about to apply");
  const compacted = await compact(state, transport, scope, device, now(), options);
  const snapshotBytes = compacted ? (newestSnapshot(Object.entries(state.files), device)?.[1].b ?? 0) : 0;
  return { published, changed: changed.size, pending: state.pending, compacted, snapshotBytes, reapplied: takeReapplied(state) };
}
