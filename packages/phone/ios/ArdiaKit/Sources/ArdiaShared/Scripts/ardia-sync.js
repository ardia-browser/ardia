"use strict";
(function () {
const __factories = new Map();
const __cache = new Map();
const __define = (path, factory) => __factories.set(path, factory);
const __export = (target, name, get) => Object.defineProperty(target, name, { get, enumerable: true, configurable: true });
const __exportAll = (target, source) => { for (const name of Object.keys(source)) if (name !== "default" && !(name in target)) __export(target, name, () => source[name]); };
const __require = (path) => {
  if (__cache.has(path)) return __cache.get(path);
  const exports = {};
  __cache.set(path, exports);
  __factories.get(path)(exports, __require);
  return exports;
};
__define("packages/sync/src/companion/index.ts", function (exports, __require) {
  __exportAll(exports, __require("packages/sync/src/canon.ts"));
  __exportAll(exports, __require("packages/sync/src/hlc.ts"));
  __exportAll(exports, __require("packages/sync/src/order.ts"));
  __exportAll(exports, __require("packages/sync/src/scope.ts"));
  __exportAll(exports, __require("packages/sync/src/scopeState.ts"));
  __exportAll(exports, __require("packages/sync/src/companion/state.ts"));
  __exportAll(exports, __require("packages/sync/src/companion/cycle.ts"));
  __export(exports, "buildView", () => __require("packages/sync/src/companion/view.ts")["buildView"]);









});
__define("packages/sync/src/canon.ts", function (exports, __require) {
  __export(exports, "canonical", () => canonical);
function canonical(value         )         {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value         )          {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out                          = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value                           )[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

});
__define("packages/sync/src/hlc.ts", function (exports, __require) {
  __export(exports, "hlcWall", () => hlcWall);
  __export(exports, "Clock", () => Clock);
                         

const WALL_DIGITS = 9;
const COUNTER_DIGITS = 4;
const COUNTER_MAX = 36 ** COUNTER_DIGITS - 1;

const formatHLC = (wall        , counter        , device        )      =>
  `${Math.max(0, Math.floor(wall)).toString(36).padStart(WALL_DIGITS, "0")}.${counter.toString(36).padStart(COUNTER_DIGITS, "0")}.${device}`;

function parseHLC(h     )                                                    {
  const [wall = "0", counter = "0", ...device] = h.split(".");
  return { wall: parseInt(wall, 36), counter: parseInt(counter, 36), device: device.join(".") };
}

const hlcWall = (h     ) => parseInt(h.slice(0, WALL_DIGITS), 36);

class Clock {
          wall = 0;
          counter = 0;
           device        ;
                   now              ;

  constructor(device        , last             , now               = Date.now) {
    this.device = device;
    this.now = now;
    if (last) this.observe(last);
  }

  tick()      {
    const t = this.now();
    if (t > this.wall) {
      this.wall = t;
      this.counter = 0;
    } else if (this.counter >= COUNTER_MAX) {
      this.wall++;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return formatHLC(this.wall, this.counter, this.device);
  }

  at(time        )      {
    return formatHLC(Math.min(time, this.now()), 0, this.device);
  }

  observe(h     ) {
    const { wall, counter } = parseHLC(h);
    if (wall > this.wall || (wall === this.wall && counter > this.counter)) {
      this.wall = wall;
      this.counter = counter;
    }
  }

  get last()      {
    return formatHLC(this.wall, this.counter, this.device);
  }
}

});
__define("packages/sync/src/order.ts", function (exports, __require) {
  __export(exports, "assignPositions", () => assignPositions);
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const digit = (c                    ) => (c === undefined ? 0 : DIGITS.indexOf(c));

function positionBetween(a        , b               )         {
  if (b !== null && a >= b) throw new Error(`positionBetween: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + positionBetween(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]);
  const db = b !== null ? digit(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)] ;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]  + positionBetween(a.slice(1), null);
}

function assignPositions(existing                        )           {
  const tails           = [];
  const previous = new Array        (existing.length).fill(-1);
  existing.forEach((p, i) => {
    if (p === undefined || !p || p.endsWith("0")) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (existing[tails[mid] ]  < p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1] ;
    tails[lo] = i;
  });
  const keep = new Set        ();
  for (let i = tails.length ? tails[tails.length - 1]  : -1; i >= 0; i = previous[i] ) keep.add(i);

  const out = new Array        (existing.length);
  for (const i of keep) out[i] = existing[i] ;
  const nextKept = new Array               (existing.length);
  let next                = null;
  for (let i = existing.length - 1; i >= 0; i--) {
    nextKept[i] = next;
    if (keep.has(i)) next = out[i] ;
  }
  let before = "";
  for (let i = 0; i < existing.length; i++) {
    if (keep.has(i)) {
      before = out[i] ;
      continue;
    }
    out[i] = positionBetween(before, nextKept[i] ?? null);
    before = out[i] ;
  }
  return out;
}

});
__define("packages/sync/src/scope.ts", function (exports, __require) {
  __export(exports, "ingestSnapshot", () => ingestSnapshot);
  __export(exports, "startRebase", () => startRebase);
  __export(exports, "rebasing", () => rebasing);
  __export(exports, "takeSessionBaseWrites", () => takeSessionBaseWrites);
  __export(exports, "flush", () => flush);
  __export(exports, "restoreJournal", () => restoreJournal);
  __export(exports, "writtenSeq", () => writtenSeq);
  __export(exports, "pull", () => pull);
  __export(exports, "compact", () => compact);
  __export(exports, "syncScope", () => syncScope);
  __exportAll(exports, __require("packages/sync/src/scopeKeys.ts"));
  __export(exports, "compactionDue", () => __require("packages/sync/src/compaction.ts")["compactionDue"]);
  __export(exports, "parseSyncFile", () => __require("packages/sync/src/syncFile.ts")["parseSyncFile"]);
const { canonical } = __require("packages/sync/src/canon.ts");
const { hlcWall } = __require("packages/sync/src/hlc.ts");
const { holdsBack, noteFileHealth } = __require("packages/sync/src/fileHealth.ts");
const { baseKeysWith, baseWritesUnder, dropBase, dropRecord, putBase, putRecord, visible } = __require("packages/sync/src/scopeKeys.ts");

const { covered, isApplied, markApplied, raiseApplied } = __require("packages/sync/src/applied.ts");
const { awaitsRecovery, cancelIfRaced, countReapplied, failedTargets, finishBatch, settleOwedRetirements, startApplying, takeReapplied, writeAhead } = __require("packages/sync/src/applyBatches.ts");
const { recoverBatches } = __require("packages/sync/src/applyRecovery.ts");
const { parseSyncFile } = __require("packages/sync/src/syncFile.ts");
const { DEFAULTS, newestSnapshot, prune, retiredBy, compactionDue } = __require("packages/sync/src/compaction.ts");


                                                                                                                                 


function see(state            , device        , at        ) {
  if (!(device in state.seen) || at > state.seen[device] ) state.seen[device] = at;
}

function mergeRecord(state            , key        , record            , clock       )          {
  clock.observe(record.h);
  const current = state.records[key];
  if (current && current.h >= record.h) return false;
  putRecord(state, key, record);
  return true;
}

function ingestLog(state            , file         , clock       , changed             ) {
  see(state, file.device, file.at);
  if (isApplied(state, [file.device, file.seq])) return;
  for (const op of file.ops) {
    if (mergeRecord(state, op.k, { h: op.h, v: op.v, o: [file.device, file.seq] }, clock)) changed.add(op.k);
  }
  markApplied(state, file.device, file.seq);
}

function ingestSnapshot(state            , file              , clock       , changed             ) {
  for (const [device, at] of Object.entries(file.seen)) see(state, device, at);
  see(state, file.device, file.at);
  for (const [key, record] of Object.entries(file.records)) {
    if (!(key in state.records) && isApplied(state, record.o)) continue;
    if (mergeRecord(state, key, record, clock)) changed.add(key);
  }
  for (const key in state.records) {
    if (!(key in file.records) && covered(file.vv, state.records[key] .o)) {
      dropRecord(state, key);
      changed.add(key);
    }
  }
  for (const [device, seq] of Object.entries(file.vv)) raiseApplied(state, device, seq);
}

const parseBase = (json                    ) => (json === undefined ? undefined : (JSON.parse(json)           ));

const settling = new WeakMap                            ();

function settleWhenDurable(state            , settle            ) {
  const queue = settling.get(state);
  if (queue) queue.push(settle);
  else settling.set(state, [settle]);
}

function settleDurable(state            ) {
  const queue = settling.get(state);
  if (!queue) return;
  settling.delete(state);
  for (const settle of queue) settle();
}

                                                            
                                                    

                                                                         
const extractedFrom = new WeakMap                                    ();

function unchangedSinceExtracted(state            , adapter         , source                    ) {
  const last = source && extractedFrom.get(state)?.get(adapter.prefix);
  return !!last && last.source === source && last.joined === state.joined && last.baseWrites === baseWritesUnder(state, adapter.prefix);
}

function noteExtracted(state            , adapter         , source                    ) {
  if (!source) return;
  let byPrefix = extractedFrom.get(state);
  if (!byPrefix) extractedFrom.set(state, (byPrefix = new Map()));
  byPrefix.set(adapter.prefix, { source, baseWrites: baseWritesUnder(state, adapter.prefix), joined: state.joined });
}

function startRebase(state            , id         ) {
  state.rebase = [];
  if (id === undefined) delete state.rebaseId;
  else state.rebaseId = id;
}

const rebasing = (state            , adapter         ) => !!state.rebase && !!adapter.sessionBacked && !state.rebase.includes(adapter.prefix);

const sessionWritesAtStart = new WeakMap                                                      ();

function sessionBaseWritesSinceStart(state            )         {
  const start = sessionWritesAtStart.get(state);
  return start ? start.prefixes.reduce((n, prefix, i) => n + baseWritesUnder(state, prefix) - start.before[i] , 0) : 0;
}

const rebasesFinished = new WeakMap                    ();

function takeSessionBaseWrites(state            )         {
  const writes = sessionBaseWritesSinceStart(state) + (rebasesFinished.get(state) ?? 0);
  const start = sessionWritesAtStart.get(state);
  if (start) start.before = start.prefixes.map((prefix) => baseWritesUnder(state, prefix));
  rebasesFinished.delete(state);
  return writes;
}

const publishesLate = (state            , adapter         ) => !!adapter.publishAfterPull || rebasing(state, adapter);

function noteRebased(state            , adapter         ) {
  if (!rebasing(state, adapter)) return;
  for (const key of baseKeysWith(state, adapter.prefix)) if (!(key in state.records)) dropBase(state, key);
  state.rebase .push(adapter.prefix);
  rebasesFinished.set(state, (rebasesFinished.get(state) ?? 0) + 1);
}

async function changesOf(state            , adapter         , now        , options               = {}) {
  if (adapter.adoptRemoteOnJoin && !state.joined) return null;
  const adopting = rebasing(state, adapter);
  if (adopting && holdsBack(state, now, options.damagedGiveUp ?? DEFAULTS.damagedGiveUp)) return { changes: [], settle: undefined, source: undefined };
  const source = adapter.extractsOnlyFrom?.();
  if (unchangedSinceExtracted(state, adapter, source)) return { changes: [], settle: undefined, source: undefined };
  let pending                     = null;
  const queued = (key        ) => (pending ??= new Set([...state.outbox, ...(state.journal ?? []).flatMap((f) => f.ops)].map((op) => op.k))).has(key);
  const extractWith = (baseJson                                     ) =>
    Promise.resolve(adapter.extract((key) => parseBase(baseJson(key)), queued, now, (key) => key in state.records, (key) => state.records[key]?.v, (key) => state.records[key]?.h, baseJson));
  const first = await extractWith((key) => state.base[key]);
  const extraction = first && state.applying ? await recoverBatches(state, adapter.prefix, first, adapter.extractUsesBase ? extractWith : null, !!adapter.savesWhole, options) : first;
  if (!extraction) return null;
  const changes           = [];
  const { values, json: knownJson, republish, ignore, keepLocal } = extraction;
  const unsettled = failedTargets(state, adapter.prefix, options);
  values.forEach((value, key) => {
    if (value === null || value === undefined) throw new Error(`[sync] ${key}: a live value can't be null`);
    const json = knownJson?.(key, value) ?? canonical(value);
    if (unsettled?.get(key)?.has(json)) return;
    if (adopting && key in state.records && !keepLocal?.(key)) return;
    if (state.base[key] === json && (!(republish?.(key) || (adopting && keepLocal?.(key))) || awaitsRecovery(state, key))) return;
    changes.push({ key, value, json });
  });
  const keys = adopting ? [] : baseKeysWith(state, adapter.prefix);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ;
    if (!(key in state.base) || values.has(key) || ignore?.(key) || unsettled?.get(key)?.has("null")) continue;
    changes.push({ key, value: null, json: "null" });
  }
  return { changes, settle: extraction.published, source };
}

function stampOf(state            , adapter         , clock       , { key, value }        )      {
  const editedAt = !state.records[key] && value !== null ? adapter.editedAt?.(value) : undefined;
  return editedAt !== undefined ? clock.at(editedAt) : clock.tick();
}

async function candidateStamps(state            , adapter         , clock       , now        , options               )                  {
  const found = await changesOf(state, adapter, now, options);
  return new Map((found?.changes ?? []).map((change) => [change.key, { json: change.json, h: stampOf(state, adapter, clock, change) }]));
}

async function publishAdapter(state            , adapter         , clock       , device        , now        , options                          , stamps         )                       {
  const published = new Set        ();
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

async function flush(state            , transport           , scope        , device        , now        , options               = {}) {
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
    const file = state.journal[0] ;
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

function restoreJournal(state            , batches           , clock       , written = 0) {
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

const writtenSeq = (state            ) => state.seq - (state.journal?.length ?? 0);

async function pull(state            , transport           , scope        , clock       , now        , options               = {}) {
  const { damagedGiveUp } = { ...DEFAULTS, ...options };
  const listing = await transport.read(scope, Object.keys(state.files).filter((id) => state.files[id] .k !== "bad"));
  const changed = new Set        ();
  const parsed                                              = [];
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

async function applyAdapter(state            , adapter         , keys             , now        , horizon        , held               , deferred             )                   {
  const mine = new Set([...keys].filter((k) => k.startsWith(adapter.prefix)));
  if (!mine.size) return true;
  const view = visible(state, adapter.prefix);
  const applyAs = (state.applyAs ??= {});
  applyAs[adapter.prefix] ??= state.joined ? "joined" : "joining";
  const settle = (key        ) => {
    if (view.has(key)) putBase(state, key, canonical(view.get(key)));
    else dropBase(state, key);
  };
  const landed = new Set        ();
  const changing = new Set([...mine].filter((key) => (state.base[key] ?? "null") !== (view.has(key) ? canonical(view.get(key)) : "null")));
  let ok                 = false;
  try {
    const records = {
      known: (key        ) => key in state.records,
      now,
      horizon,
      joined: applyAs[adapter.prefix] === "joined",
      held,
      rebasing: rebasing(state, adapter),
      landed: (key        ) => void landed.add(key),
      defer: (key        ) => void (mine.has(key) && deferred.add(key)),
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

async function compact(state            , transport           , scope        , device        , now        , options               = {}, force = false) {
  const o = { ...DEFAULTS, ...options };
  if (!force && !compactionDue(state, now, o)) {
    const own = newestSnapshot(Object.entries(state.files), device);
    if (own) await prune(state, transport, scope, retiredBy(Object.entries(state.files), own[0], own[1].vv ?? {}, now, o.pruneGrace, "logs")).catch((error) => console.warn("[sync] removing covered files failed", error));
    return false;
  }
  await flush(state, transport, scope, device, now, options);
  const records                             = {};
  const tombstoneTTL = Object.keys(state.extra).length ? 2 * o.tombstoneTTL : o.tombstoneTTL;
  for (const [key, record] of Object.entries(state.records)) {
    const drop = record.v === null ? now - hlcWall(record.h) > tombstoneTTL : o.expired(key, record.v, now);
    if (drop) dropRecord(state, key);
    else records[key] = record;
  }
  const vv = { ...state.vv };
  const file               = { v: 1, kind: "snapshot", device, at: now, vv, seen: { ...state.seen }, records };
  const payload = JSON.stringify(file);
  const id = await transport.write(scope, payload);
  state.files[id] = { d: device, k: "snapshot", vv, at: now, b: payload.length };
  state.snapshotAt = now;
  await prune(state, transport, scope, retiredBy(Object.entries(state.files), id, vv, now, o.pruneGrace, "logsAndSnapshots"));
  return true;
}

                                                                                                                                                                    

async function syncScope(args   
                
                    
                       
                      
               
                 
                     
                         
 )                       {
  const { scope, state, transport, adapters, clock, device, options } = args;
  const now = args.now ?? Date.now;
  startApplying(state, now(), options);
  await settleOwedRetirements(state, options);
  const sessionPrefixes = adapters.filter((a) => a.sessionBacked).map((a) => a.prefix);
  sessionWritesAtStart.set(state, { prefixes: sessionPrefixes, before: sessionPrefixes.map((prefix) => baseWritesUnder(state, prefix)) });
  let published = 0;
  const stamps = new Map                 ();
  for (const adapter of adapters) {
    if (publishesLate(state, adapter)) stamps.set(adapter, await candidateStamps(state, adapter, clock, now(), options));
    else published += (await publishAdapter(state, adapter, clock, device, now(), options)).size;
  }
  await flush(state, transport, scope, device, now(), options);
  const changed = await pull(state, transport, scope, clock, now(), options);
  const held = holdsBack(state, now(), options?.damagedGiveUp ?? DEFAULTS.damagedGiveUp);
  const keys = new Set([...state.unapplied, ...changed]);
  if (!held) for (const adapter of adapters) if (rebasing(state, adapter)) for (const key of Object.keys(state.records)) if (key.startsWith(adapter.prefix)) keys.add(key);
  const unapplied           = [];
  let heldApply = false;
  let journalFailed = false;
  const applyHeld = () => !!options?.holdApply?.();
  for (const adapter of adapters) {
    const publishLate = async () => {
      const late = publishesLate(state, adapter) && held ? new Set        () : await publishAdapter(state, adapter, clock, device, now(), options, stamps.get(adapter));
      published += late.size;
      for (const key of late) keys.delete(key);
      return late;
    };
    const late = await publishLate();
    for (const key of state.unapplied) if (key.startsWith(adapter.prefix) && !late.has(key)) keys.add(key);
    heldApply ||= applyHeld();
    const rebaseWaits = held && rebasing(state, adapter);
    const deferred = new Set        ();
    const ahead                    = heldApply || rebaseWaits ? null : await writeAhead(state, adapter.prefix, keys, now(), options);
    const cancelled = !!ahead?.batch && (await cancelIfRaced(state, ahead.batch, await publishLate(), options));
    journalFailed ||= !!ahead?.failed;
    heldApply ||= !!ahead?.failed;
    const applied = !heldApply && !rebaseWaits && !cancelled && (await applyAdapter(state, adapter, keys, now(), 2 * (options?.tombstoneTTL ?? DEFAULTS.tombstoneTTL), applyHeld, deferred));
    finishBatch(ahead?.batch ?? null, applied, options);
    if (applied && !deferred.size && !held) noteRebased(state, adapter);
    heldApply ||= applyHeld();
    if (!applied) for (const key of keys) if (key.startsWith(adapter.prefix)) unapplied.push(key);
    if (applied) for (const key of deferred) unapplied.push(key);
  }
  state.unapplied = [...unapplied, ...[...keys].filter((k) => !adapters.some((a) => k.startsWith(a.prefix)))];
  if (state.awaitRemote) state.awaitSince = Math.min(state.awaitSince ?? now(), now());
  const waitedOut = !!state.awaitRemote && now() - state.awaitSince  > (options?.damagedGiveUp ?? DEFAULTS.damagedGiveUp);
  if (!heldApply && (!state.awaitRemote || waitedOut || (!held && Object.keys(state.seen).some((d) => d !== device)))) {
    state.joined = true;
    delete state.awaitRemote;
    delete state.awaitSince;
  }
  await flush(state, transport, scope, device, now(), options);
  if (journalFailed) throw new Error("[sync] couldn't journal what this cycle was about to apply");
  const compacted = await compact(state, transport, scope, device, now(), options);
  const snapshotBytes = compacted ? (newestSnapshot(Object.entries(state.files), device)?.[1].b ?? 0) : 0;
  const sessionBaseWrites = sessionBaseWritesSinceStart(state);
  return { published, changed: changed.size, pending: state.pending, compacted, snapshotBytes, reapplied: takeReapplied(state), sessionBaseWrites };
}

});
__define("packages/sync/src/scopeKeys.ts", function (exports, __require) {
  __export(exports, "visible", () => visible);
  __export(exports, "recordsWith", () => recordsWith);
  __export(exports, "trackTouchedKeys", () => trackTouchedKeys);
  __export(exports, "baseWritesUnder", () => baseWritesUnder);
  __export(exports, "putRecord", () => putRecord);
  __export(exports, "dropRecord", () => dropRecord);
  __export(exports, "baseKeysWith", () => baseKeysWith);
  __export(exports, "putBase", () => putBase);
  __export(exports, "dropBase", () => dropBase);
                                                              

function visible(state            , prefix        )                       {
  const out = new Map                 ();
  const { records } = state;
  for (const key in records) {
    if (!key.startsWith(prefix)) continue;
    const value = records[key] .v;
    if (value !== null) out.set(key, value);
  }
  return out;
}

function recordsWith(state            , prefix        )                         {
  const out                         = [];
  const { records } = state;
  for (const key in records) if (key.startsWith(prefix)) out.push([key, records[key] ]);
  return out;
}

                                                               
const touching = new WeakMap                              ();

function trackTouchedKeys(state            )                                             {
  const touched              = { records: new Set(), base: new Set() };
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

function touch(state            , kind                   , key        ) {
  const all = touching.get(state);
  if (all) for (const touched of all) touched[kind].add(key);
}

const baseWrites = new WeakMap                                 ();

function baseWritesUnder(state            , prefix        )         {
  let counts = baseWrites.get(state);
  if (!counts) baseWrites.set(state, (counts = new Map()));
  const count = counts.get(prefix);
  if (count !== undefined) return count;
  counts.set(prefix, 0);
  return 0;
}

function countBaseWrite(state            , key        ) {
  baseWrites.get(state)?.forEach((count, prefix, counts) => {
    if (key.startsWith(prefix)) counts.set(prefix, count + 1);
  });
}

function putRecord(state            , key        , record            ) {
  state.records[key] = record;
  touch(state, "records", key);
}

function dropRecord(state            , key        ) {
  if (!(key in state.records)) return;
  delete state.records[key];
  touch(state, "records", key);
}

                                                                 
const baseIndexes = new WeakMap                                     ();

function baseKeysWith(state            , prefix        )                    {
  let byPrefix = baseIndexes.get(state);
  if (!byPrefix) baseIndexes.set(state, (byPrefix = new Map()));
  let keys = byPrefix.get(prefix);
  if (!keys) {
    const live = new Set        ();
    for (const key in state.base) if (key.startsWith(prefix)) live.add(key);
    byPrefix.set(prefix, (keys = { live, listed: null }));
  }
  return (keys.listed ??= [...keys.live]);
}

function putBase(state            , key        , json        ) {
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

function dropBase(state            , key        ) {
  if (!(key in state.base)) return;
  delete state.base[key];
  touch(state, "base", key);
  countBaseWrite(state, key);
  baseIndexes.get(state)?.forEach((keys) => {
    if (keys.live.delete(key)) keys.listed = null;
  });
}

});
__define("packages/sync/src/compaction.ts", function (exports, __require) {
  __export(exports, "DEFAULTS", () => DEFAULTS);
  __export(exports, "newestSnapshot", () => newestSnapshot);
  __export(exports, "retiredBy", () => retiredBy);
  __export(exports, "prune", () => prune);
  __export(exports, "compactionDue", () => compactionDue);
const { covered } = __require("packages/sync/src/applied.ts");
                                                                           

const DEFAULTS                                                                                                                      = {
  expired: () => false,
  tombstoneTTL: 45 * 86_400_000,
  compactAfterFiles: 40,
  compactAfterLogs: 400,
  compactLogShare: 0.25,
  compactInterval: 10 * 60_000,
  pruneGrace: 60 * 60_000,
  damagedGiveUp: 86_400_000,
};

                                                       

const dominates = (vv                        , other                        ) => Object.entries(other).every(([d, s]) => (vv[d] ?? 0) >= s);

function newestSnapshot(entries             , device         ) {
  let newest                       ;
  for (const entry of entries) if (entry[1].k === "snapshot" && (!device || entry[1].d === device) && (!newest || entry[1].at > newest[1].at)) newest = entry;
  return newest;
}

function retiredBy(entries             , snapshotId        , vv                        , now        , pruneGrace        , kinds                             ) {
  return entries
    .filter(([fileId, f]) => {
      if (fileId === snapshotId || now - f.at < pruneGrace) return false;
      if (f.k === "log") return covered(vv, [f.d, f.s ?? Infinity]);
      if (f.k === "snapshot") return kinds === "logsAndSnapshots" && dominates(vv, f.vv ?? {});
      return false;
    })
    .map(([fileId]) => fileId);
}

async function prune(state            , transport           , scope        , ids          ) {
  if (!ids.length) return;
  await transport.remove(scope, ids);
  for (const fileId of ids) delete state.files[fileId];
}

function compactionDue(state            , now        , options               = {}) {
  const o = { ...DEFAULTS, ...options };
  const entries = Object.entries(state.files);
  const latest = newestSnapshot(entries);
  if (now - Math.max(state.snapshotAt, latest?.[1].at ?? 0) < o.compactInterval) return false;
  const base = latest?.[1].vv ?? {};
  let logs = 0;
  let logBytes = 0;
  for (const [, f] of entries) {
    if (f.k !== "log" || covered(base, [f.d, f.s ?? Infinity]) || !covered(state.vv, [f.d, f.s ?? Infinity])) continue;
    logs++;
    logBytes += f.b ?? 0;
  }
  if (logs <= o.compactAfterFiles) return false;
  return logs >= o.compactAfterLogs || logBytes >= o.compactLogShare * (latest?.[1].b ?? 0);
}


});
__define("packages/sync/src/applied.ts", function (exports, __require) {
  __export(exports, "covered", () => covered);
  __export(exports, "markApplied", () => markApplied);
  __export(exports, "isApplied", () => isApplied);
  __export(exports, "raiseApplied", () => raiseApplied);
                                                          

const covered = (vv                        , [device, seq]        ) => (vv[device] ?? 0) >= seq;

function sortedIndex(list          , seq        ) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]  < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function markApplied(state            , device        , seq        ) {
  if (covered(state.vv, [device, seq])) return;
  const extra = state.extra[device] ?? [];
  const at = sortedIndex(extra, seq);
  if (extra[at] !== seq) extra.splice(at, 0, seq);
  let top = state.vv[device] ?? 0;
  let taken = 0;
  while (extra[taken] === top + 1) top = extra[taken++] ;
  state.vv[device] = top;
  const left = taken ? extra.slice(taken) : extra;
  if (left.length) state.extra[device] = left;
  else delete state.extra[device];
}

const isApplied = (state            , [device, seq]        ) => {
  if (covered(state.vv, [device, seq])) return true;
  const extra = state.extra[device];
  return !!extra && extra[sortedIndex(extra, seq)] === seq;
};

function raiseApplied(state            , device        , seq        ) {
  if (seq <= (state.vv[device] ?? 0)) return;
  state.vv[device] = seq;
  const extra = (state.extra[device] ?? []).filter((s) => s > seq);
  let taken = 0;
  for (let top = seq; extra[taken] === top + 1; top++) state.vv[device] = extra[taken++] ;
  const left = extra.slice(taken);
  if (left.length) state.extra[device] = left;
  else delete state.extra[device];
}

});
__define("packages/sync/src/syncFile.ts", function (exports, __require) {
  __export(exports, "parseSyncFile", () => parseSyncFile);
                                                                       

const isObject = (v         )                               => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v         )              => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isTime = (v         )              => typeof v === "number" && Number.isFinite(v);
const isMapOf = (v         , item                         ) => isObject(v) && Object.values(v).every(item);
const isOrigin = (v         ) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && isCount(v[1]);
const isValue = (o                         ) => Object.prototype.hasOwnProperty.call(o, "v") && o.v !== undefined;
const isOp = (v         ) => isObject(v) && typeof v.k === "string" && typeof v.h === "string" && isValue(v);
const isRecord = (v         ) => isObject(v) && typeof v.h === "string" && isOrigin(v.o) && isValue(v);

function parseSyncFile(payload        )                  {
  let file         ;
  try {
    file = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(file) || file.v !== 1 || typeof file.device !== "string" || !isTime(file.at)) return null;
  if (file.kind === "log") return isCount(file.seq) && Array.isArray(file.ops) && file.ops.every(isOp) ? (file           ) : null;
  if (file.kind === "snapshot") {
    return isMapOf(file.vv, isCount) && isMapOf(file.seen, isTime) && isMapOf(file.records, isRecord) ? (file                ) : null;
  }
  return null;
}

});
__define("packages/sync/src/fileHealth.ts", function (exports, __require) {
  __export(exports, "noteFileHealth", () => noteFileHealth);
  __export(exports, "holdsBack", () => holdsBack);
  __export(exports, "pullSettled", () => pullSettled);
                                                  

                                                                                                     

function noteFileHealth(state            , files             , now        , giveUp        ) {
  const setAside = (id        ) => state.files[id]?.k === "bad";
  for (const id of files.read) delete state.damaged[id];
  for (const id of files.unreadable) {
    if (setAside(id)) continue;
    const since = Math.min(state.damaged[id] ?? now, now);
    if (now - since > giveUp) {
      state.files[id] = { d: "", k: "bad", at: now };
      delete state.damaged[id];
    } else {
      state.damaged[id] = since;
    }
  }
  for (const id of Object.keys(state.damaged)) if (!files.present.has(id)) delete state.damaged[id];
  const pending = files.pending.filter((id) => !setAside(id));
  state.pending = pending.length;
  if (pending.length) state.pendingSince = Object.fromEntries(pending.map((id) => [id, Math.min(state.pendingSince?.[id] ?? now, now)]));
  else delete state.pendingSince;
}

const holdsBack = (state            , now        , window        ) =>
  Object.keys(state.damaged).length > 0 || Object.values(state.pendingSince ?? {}).some((at) => now - at <= window);

const pullSettled = (state            ) =>
  state.pending === 0 && Object.keys(state.damaged).length === 0 && !Object.values(state.files).some((f) => f.k === "bad");

});
__define("packages/sync/src/applyBatches.ts", function (exports, __require) {
  __export(exports, "ABSENT", () => ABSENT);
  __export(exports, "UNSEEN_KEPT_MS", () => UNSEEN_KEPT_MS);
  __export(exports, "launchOf", () => launchOf);
  __export(exports, "isApplyBatch", () => isApplyBatch);
  __export(exports, "validBatches", () => validBatches);
  __export(exports, "writeAhead", () => writeAhead);
  __export(exports, "cancelIfRaced", () => cancelIfRaced);
  __export(exports, "settleOwedRetirements", () => settleOwedRetirements);
  __export(exports, "finishBatch", () => finishBatch);
  __export(exports, "startApplying", () => startApplying);
  __export(exports, "queueRecovered", () => queueRecovered);
  __export(exports, "awaitsRecovery", () => awaitsRecovery);
  __export(exports, "countReapplied", () => countReapplied);
  __export(exports, "failedTargets", () => failedTargets);
  __export(exports, "takeReapplied", () => takeReapplied);
const { canonical } = __require("packages/sync/src/canon.ts");
const { visible } = __require("packages/sync/src/scopeKeys.ts");
                                                                            

const ABSENT = "null";
const NATIVE_SAVE_MS = 30_000;
const UNSEEN_KEPT_MS = 86_400_000;

const thisLaunch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const steadyNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const launchOf = (options               = {}) => options.launch ?? thisLaunch;
const monotonicOf = (options               = {}) => (options.monotonic ?? steadyNow)();

function isJsonOrNull(v         ) {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}
const isStep = (v         ) => Array.isArray(v) && v.length === 2 && isJsonOrNull(v[0]) && isJsonOrNull(v[1]);
const isFiniteNumber = (v         )              => typeof v === "number" && Number.isFinite(v);

function isApplyBatch(v         )                  {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v                           ;
  if (!isFiniteNumber(b.id) || typeof b.p !== "string" || typeof b.l !== "string" || !isFiniteNumber(b.at)) return false;
  if (b.done !== undefined && !isFiniteNumber(b.done)) return false;
  if ([b.r, b.f, b.ok].some((flag) => flag !== undefined && flag !== 1)) return false;
  if (b.cut !== undefined && !(Array.isArray(b.cut) && b.cut.every((key) => typeof key === "string"))) return false;
  return typeof b.k === "object" && b.k !== null && !Array.isArray(b.k) && Object.values(b.k).every(isStep);
}

const validBatches = (v         )               => (Array.isArray(v) ? v.filter(isApplyBatch) : []);

function noteBatch(state            , prefix        , keys                  , now        , options              )                    {
  const view = visible(state, prefix);
  const k                  = {};
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
  const batch             = { id, p: prefix, l: launchOf(options), at: now, k };
  batches.push(batch);
  return batch;
}

function dropBatch(state            , batch            ) {
  state.applying = state.applying?.filter((b) => b !== batch);
  if (!state.applying?.length) delete state.applying;
}

                                                                       

async function writeAhead(state            , prefix        , keys                  , now        , options               = {})                      {
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

const owedRetirements = new WeakMap                          ();

async function retire(state            , batch            , options              ) {
  try {
    await options.persistApplying?.({ ...batch, k: {} });
  } catch (error) {
    owedRetirements.set(state, [...(owedRetirements.get(state) ?? []).filter((b) => b.id !== batch.id), batch]);
    throw error;
  }
}

async function cancelIfRaced(state            , batch                   , raced             , options               = {})                   {
  if (!batch || !Object.keys(batch.k).some((key) => raced.has(key))) return false;
  dropBatch(state, batch);
  await retire(state, batch, options);
  return true;
}

async function settleOwedRetirements(state            , options               = {}) {
  const owed = owedRetirements.get(state);
  if (!owed?.length) return;
  owedRetirements.delete(state);
  for (const batch of owed) await retire(state, batch, options);
}

function finishBatch(batch                   , applied         , options               = {}) {
  if (!batch) return;
  batch.done = monotonicOf(options);
  if (applied) batch.ok = 1;
  else batch.f = 1;
}

function startApplying(state            , now        , options               = {}) {
  takeReapplied(state);
  if (!state.applying) return;
  const launch = launchOf(options);
  const steady = monotonicOf(options);
  const saveMs = options.nativeSaveMs ?? NATIVE_SAVE_MS;
  const retrying = new Set(state.unapplied);
  const live = (b            ) => {
    if (b.l === launch && b.f && Object.keys(b.k).some((key) => retrying.has(key))) return true;
    if (b.l === launch) return b.done === undefined || steady - b.done < saveMs;
    return !b.r || now - b.at < UNSEEN_KEPT_MS;
  };
  state.applying = state.applying.filter(live);
  if (!state.applying.length) delete state.applying;
}

                                           
const recovering = new WeakMap                        ();
const reapplied = new WeakMap                    ();

function queueRecovered(state            , keys          ) {
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

const awaitsRecovery = (state            , key        ) => !!recovering.get(state)?.pending.has(key);

function countReapplied(state            , applied                  , deferred             , changed             ) {
  const marks = recovering.get(state);
  if (!marks?.pending.size) return;
  let count = 0;
  for (const key of applied) {
    if (deferred.has(key) || !marks.pending.delete(key)) continue;
    if (changed.has(key)) count++;
  }
  if (count) reapplied.set(state, (reapplied.get(state) ?? 0) + count);
}

function failedTargets(state            , prefix        , options               = {})                                  {
  const launch = launchOf(options);
  let targets                                  = null;
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

function takeReapplied(state            )         {
  const count = reapplied.get(state) ?? 0;
  reapplied.delete(state);
  return count;
}

});
__define("packages/sync/src/applyRecovery.ts", function (exports, __require) {
  __export(exports, "recoverBatches", () => recoverBatches);
const { canonical } = __require("packages/sync/src/canon.ts");
const { ABSENT, launchOf, queueRecovered } = __require("packages/sync/src/applyBatches.ts");
const { dropBase, putBase, visible } = __require("packages/sync/src/scopeKeys.ts");
                                                                                        

                                                                       
                                                                                                        

const nativeJson = (extraction            , key        ) => {
  if (!extraction.values.has(key)) return ABSENT;
  const value = extraction.values.get(key);
  return extraction.json?.(key, value) ?? canonical(value);
};

function setBase(state            , key        , json        ) {
  if (json === ABSENT) dropBase(state, key);
  else putBase(state, key, json);
}

function chainsOf(batches              , skip                          ) {
  const chains = new Map                ();
  batches.forEach((batch, at) => {
    for (const [key, [from, to]] of Object.entries(batch.k)) {
      if (skip(key)) continue;
      let chain = chains.get(key);
      if (!chain) chains.set(key, (chain = []));
      chain.push({ at, from: from ?? ABSENT, to: to ?? ABSENT, partial: !batch.ok });
    }
  });
  return chains;
}

function valueAt(chain        , hypothesis        )         {
  let last                  ;
  for (const step of chain) if (step.at < hypothesis) last = step;
  return last ? last.to : chain[0] .from;
}

const holds = (chain                    , json        ) => !!chain?.some((s) => s.to === json || s.from === json);
const leftOver = (chain        , json        , savesWhole         ) => (!savesWhole || chain.some((s) => s.partial)) && holds(chain, json);

                                                                                                                            

async function tryHypothesis(state            , chains                     , hypothesis        , first            , extractWith                    )                 {
  const overrides = new Map                ();
  for (const [key, chain] of chains) overrides.set(key, valueAt(chain, hypothesis));
  const baseJson = (key        ) => {
    const json = overrides.has(key) ? overrides.get(key)  : state.base[key];
    return json === ABSENT ? undefined : json;
  };
  const same = [...overrides].every(([key, json]) => (state.base[key] ?? ABSENT) === json);
  const extraction = same || !extractWith ? first : await extractWith(baseJson);
  if (!extraction) return { hypothesis, extraction: first, matches: -1, baseJson };
  let matches = 0;
  for (const [key, chain] of chains) {
    if (extraction.ignore?.(key)) continue;
    if (nativeJson(extraction, key) === valueAt(chain, hypothesis)) matches++;
  }
  return { hypothesis, extraction, matches, baseJson };
}

function keepUnresolved(state            , batches              , resolved             ) {
  const kept               = [];
  for (const batch of state.applying ?? []) {
    if (!batches.includes(batch)) {
      kept.push(batch);
      continue;
    }
    const left = Object.entries(batch.k).filter(([key]) => !resolved.has(key));
    const cut = Object.keys(batch.k).filter((key) => resolved.has(key));
    if (left.length) kept.push({ ...batch, r: 1, ...(cut.length ? { cut: [...(batch.cut ?? []), ...cut] } : {}), k: Object.fromEntries(left) });
  }
  if (kept.length) state.applying = kept;
  else delete state.applying;
}

async function recoverBatches(state            , prefix        , first            , extractWith                    , savesWhole         , options               = {})                             {
  const launch = launchOf(options);
  const batches = (state.applying ?? []).filter((b) => b.p === prefix && b.l !== launch).sort((a, z) => a.id - z.id);
  if (!batches.length) return first;
  const chains = chainsOf(batches, (key) => !!first.ignore?.(key));
  if (!chains.size) {
    if (batches.some((b) => !b.r)) keepUnresolved(state, batches, new Set());
    return first;
  }
  let best               = null;
  for (let hypothesis = 0; hypothesis <= batches.length; hypothesis++) {
    const trial = await tryHypothesis(state, chains, hypothesis, first, extractWith);
    if (trial.matches < 0) return null;
    if (!best || trial.matches > best.matches) best = trial;
  }
  const { extraction, hypothesis, baseJson } = best ;
  const view = visible(state, prefix);
  const sinceRestart = chainsOf((state.applying ?? []).filter((b) => b.p === prefix && b.l === launch), (key) => !chains.has(key));
  const resolved = new Set        ();
  const queue           = [];
  for (const [key, chain] of chains) {
    if (extraction.ignore?.(key)) continue;
    resolved.add(key);
    const actual = nativeJson(extraction, key);
    if (actual !== valueAt(chain, hypothesis) && !leftOver(chain, actual, savesWhole) && !holds(sinceRestart.get(key), actual)) {
      setBase(state, key, baseJson(key) ?? ABSENT);
      continue;
    }
    setBase(state, key, actual);
    const target = view.has(key) ? canonical(view.get(key)) : ABSENT;
    const recordBehind = target !== actual && chain.some((s) => s.from === target) && !chain.some((s) => s.to === target);
    if (recordBehind) continue;
    queue.push(key);
  }
  keepUnresolved(state, batches, resolved);
  queueRecovered(state, queue);
  return extraction;
}

});
__define("packages/sync/src/scopeState.ts", function (exports, __require) {
  __export(exports, "emptyScope", () => emptyScope);
                                    

                                                   
                                                           
                                            

                                                                                                
                            
       
                   
                 
             
                             
                               
                                      
  
                                              

                                                                                                                                                                                            

                                                                                                                              

                          
                                      
                               
                      
                             
                                  
                                  
                                  
                                        
              
               
                      
                               
                  
                        
                      
                    
                    
                                                 
                          
                     
                  
  

const emptyScope = ()             => ({
  records: {},
  base: {},
  unapplied: [],
  vv: {},
  extra: {},
  files: {},
  damaged: {},
  seq: 0,
  outbox: [],
  seen: {},
  joined: false,
  snapshotAt: 0,
  pending: 0,
});

                            
                                                         
                                                         
                                                      
 

                       
                                           
                    
                                         
                    
  

                          
                               
                                    
                                       
                                       
                                          
                                                             
  

                            
                              
              
                  
                  
                  
                     
                            
                           
  

                          
                 
          
                                   
                                     
                
                                    
                                     
                                            
                                                  
                                                    
                                                                                                                                                              
                                                
                                          
                              
                          
                             
                            
                       
 

                            
                                                                  
                        
                             
                            
                           
                           
                      
                         
                                                  
                            
                                                         
                  
                        
                           
  

});
__define("packages/sync/src/companion/state.ts", function (exports, __require) {
  __export(exports, "host", () => host);
  __export(exports, "loaded", () => loaded);
  __export(exports, "companionLoad", () => companionLoad);
  __export(exports, "companionUnload", () => companionUnload);
  __export(exports, "companionStateUnsaved", () => companionStateUnsaved);
  __export(exports, "save", () => save);
  __export(exports, "viewIsNew", () => viewIsNew);
const { Clock } = __require("packages/sync/src/hlc.ts");
const { restoreJournal } = __require("packages/sync/src/scope.ts");
const { emptyScope } = __require("packages/sync/src/scopeState.ts");
                                                                  

                    
                        
                                                 
                                                
                                                 
                                                             
                                                         
  

                              
       
                 
                       
                                     
                       
              
                          
                                                 
                               
                                                   
                                             
                                      
                                           
                                
  

let companion                        = null;
let savedJSON = "";
let savedPrint = "";
let viewJSON = "";

const host = ()       => {
  const h = (globalThis                     ).__host;
  if (!h) throw new Error("the sync host isn't registered");
  return h;
};

function loaded()                 {
  if (!companion) throw new Error("the companion isn't loaded");
  return companion;
}

const freshState = (device        )                 => ({ v: 1, device, clock: null, scopes: {}, sends: [], acks: [], bookmarks: [], floors: {}, pulled: {} });

function companionLoad(input                                                                                                                                   ) {
  if (!input.state && !input.fresh) throw new Error("no saved state for this device");
  if (input.state && (input.state.v !== 1 || input.state.device !== input.device || !input.state.scopes || typeof input.state.scopes !== "object")) {
    throw new Error("the saved state belongs to another device or version");
  }
  const state = input.state ?? freshState(input.device);
  state.sends ??= [];
  state.acks ??= [];
  state.bookmarks ??= [];
  state.floors ??= {};
  state.pulled ??= {};
  state.scopes ??= {};
  state.visited ??= {};
  state.due ??= {};
  state.removals ??= {};
  state.ghosts ??= [];
  state.sent ??= {};
  for (const id of input.ghosts ?? []) if (id !== input.device && !state.ghosts.some((g) => g.id === id)) state.ghosts.push({ id, since: Date.now() });
  const clock = new Clock(input.device, state.clock);
  let restored = false;
  for (const [scope, batches] of Object.entries(input.journal ?? {})) {
    const mine = (Array.isArray(batches) ? batches : []).filter((f) => f && f.device === input.device);
    if (!mine.length) continue;
    restoreJournal((state.scopes[scope] ??= emptyScope()), mine, clock, 0);
    restored = true;
  }
  if (restored) state.clock = clock.last;
  companion = state;
  savedJSON = "";
  savedPrint = "";
  viewJSON = "";
  return { device: state.device, scopes: Object.keys(state.scopes).length };
}

function companionUnload() {
  companion = null;
  savedJSON = "";
  savedPrint = "";
  viewJSON = "";
  return true;
}

function companionStateUnsaved() {
  savedJSON = "";
  savedPrint = "";
  return true;
}

function fingerprint(c                )         {
  const scopes = Object.keys(c.scopes)
    .sort()
    .map((name) => {
      const s = c.scopes[name] ;
      return [name, s.seq, s.journal?.length ?? 0, s.outbox.length, Object.keys(s.files).length, s.pending, Object.keys(s.damaged).length, s.unapplied.length, s.joined, JSON.stringify(s.vv), JSON.stringify(s.extra), JSON.stringify(s.seen)].join("|");
    });
  return JSON.stringify([c.clock, scopes, c.sends, c.acks, c.bookmarks, c.floors, c.pulled, c.visited, c.due, c.removals, c.ghosts, c.sent]);
}

function save(force = false)          {
  const c = loaded();
  const print = fingerprint(c);
  if (!force && savedJSON && print === savedPrint) return true;
  const json = JSON.stringify(c);
  if (json === savedJSON) {
    savedPrint = print;
    return true;
  }
  const seqs = Object.fromEntries(Object.entries(c.scopes).map(([scope, s]) => [scope, s.seq]));
  if (host().saveState(json, JSON.stringify(seqs)) !== "ok") return false;
  savedJSON = json;
  savedPrint = print;
  return true;
}

function viewIsNew(json        )          {
  if (json === viewJSON) return false;
  viewJSON = json;
  return true;
}

});
__define("packages/sync/src/companion/cycle.ts", function (exports, __require) {
  __export(exports, "runCompanionCycle", () => runCompanionCycle);
  __export(exports, "companionView", () => companionView);
  __export(exports, "companionSend", () => companionSend);
  __export(exports, "companionRemovalsDone", () => companionRemovalsDone);
  __export(exports, "companionAcknowledge", () => companionAcknowledge);
  __export(exports, "companionAddBookmark", () => companionAddBookmark);
  __export(exports, "companionRemoveBookmark", () => companionRemoveBookmark);
const { Clock } = __require("packages/sync/src/hlc.ts");
const { syncScope, visible } = __require("packages/sync/src/scope.ts");
const { emptyScope } = __require("packages/sync/src/scopeState.ts");
const { bookmarksAdapter, deviceAdapter, deviceTabsAdapter, historyAdapter, historyExpired, HISTORY_WINDOW_MS, isWebUrl, sendsAdapter, SEND_LIFETIME_MS, DAY_MS } = __require("packages/sync/src/companion/adapters.ts");
const { fromLegacyUrl } = __require("packages/sync/src/companion/legacy.ts");
const { buildView, dataOwner, defaultProfileId, liveProfiles } = __require("packages/sync/src/companion/view.ts");
const { host, loaded, save, viewIsNew } = __require("packages/sync/src/companion/state.ts");

                                                    

                          
               
               
                     
                           
                               
                        
  

                                                                                                                          
                                                                        

                    
                      
              
                       
                            
                      
                    
                  
                  
                 
  

const APP = "app";
const GHOST_MS = 30 * 86_400_000;

function removalsOf(c                )            {
  const fallback = defaultProfileId(liveProfiles(c.scopes[APP]));
  return Object.entries(c.removals ?? {})
    .filter(([, urls]) => urls.length)
    .sort(([a], [z]) => (a < z ? -1 : 1))
    .map(([profile, urls]) => ({ profile, urls: [...urls].sort(), unassigned: profile === fallback }));
}

const dueOf = (c                ) => [...new Set(Object.values(c.due ?? {}).flatMap((urls) => Object.keys(urls)))].sort();
const profileScope = (syncId        ) => `p:${syncId}`;

const transport            = {
  read: async (scope, known) => JSON.parse(host().read(scope, JSON.stringify(known)))           ,
  write: async (scope, payload) => host().write(scope, payload),
  remove: async (scope, ids) => {
    host().remove(scope, JSON.stringify(ids));
  },
};

const persistJournal =
  (scope        ) =>
  async (batches           )                => {
    if (host().persistJournal(scope, JSON.stringify(batches.map((batch) => JSON.stringify(batch)))) !== "ok") throw new Error("couldn't save the sync journal");
  };

const scopeOptions = (scope        , profile         )               => ({
  persist: persistJournal(scope),
  compactAfterFiles: Infinity,
  ...(profile ? { expired: historyExpired } : {}),
});

function dropFrom                                          (list     , scope        , keys             )      {
  return keys.size ? list.filter((x) => x.scope !== scope || !keys.has(x.key)) : list;
}

function profileOf(app                        , profiles             , fallback               , p                           )                {
  if (p && profiles.has(p)) return p;
  return fallback;
}

async function runCompanionCycle(input            )                       {
  const c = loaded();
  const now = () => input.now ?? Date.now();
  const empty = { received: [], historyRemoved: removalsOf(c), visitsDue: dueOf(c), published: 0, changed: 0, pending: 0 };
  const status = host().chainStatus()               ;
  if (status !== "ok") return { status, ...empty, saved: save(false) };
  const clock = new Clock(c.device, c.clock, now);
  const device = c.device;
  const retiring = !!input.retiring;
  let published = 0;
  let changed = 0;
  let pending = 0;
  const run = async (scope        , adapters           , profile         ) => {
    const state = (c.scopes[scope] ??= emptyScope());
    const result = await syncScope({ scope, state, transport, adapters, clock, device, now, options: scopeOptions(scope, profile) });
    state.unapplied = state.unapplied.filter((k) => adapters.some((a) => k.startsWith(a.prefix)));
    c.pulled[scope] = true;
    published += result.published;
    changed += result.changed;
    pending += result.pending;
    return state;
  };

  c.ghosts = (c.ghosts ?? []).filter((g) => now() - g.since < GHOST_MS);
  const ghosts = c.ghosts.map((g) => g.id);
  const app = await run(APP, [deviceAdapter(device, input.name, retiring, ghosts)], false);
  if (retiring) {
    for (const scope of Object.keys(c.scopes).filter((s) => s.startsWith("p:"))) await run(scope, [deviceTabsAdapter(device, input.name, [], true, ghosts)], true);
  } else {
    const profiles = liveProfiles(app);
    const ids = new Set(profiles.keys());
    const fallback = defaultProfileId(profiles);
    const owner = new Map([...ids].map((id) => [id, dataOwner(app, id)]));
    const tabsOf = new Map                    ();
    for (const t of input.tabs ?? []) {
      const p = profileOf(app, ids, fallback, t.p);
      if (!p) continue;
      const list = tabsOf.get(p);
      if (list) list.push(t);
      else tabsOf.set(p, [t]);
    }
    const visitsOf = new Map                                        ();
    const visited = (c.visited ??= {});
    const removing = new WeakMap                       ();
    for (const v of input.visits ?? []) {
      const p = profileOf(app, ids, fallback, v.p);
      if (!p || typeof v.u !== "string" || !Array.isArray(v.vt)) continue;
      const o = owner.get(p) ?? p;
      const list = visitsOf.get(o);
      if (list) list.push({ ...v, p });
      else visitsOf.set(o, [{ ...v, p }]);
      const newest = v.vt.reduce((m, t) => (Number.isFinite(t) ? Math.max(m, t) : m), -Infinity);
      const mine = (visited[profileScope(o)] ??= {});
      if (Number.isFinite(newest) && newest > (mine[v.u] ?? -Infinity)) mine[v.u] = newest;
    }
    for (const id of [...ids].sort()) {
      const scope = profileScope(id);
      const ownsData = owner.get(id) === id;
      const floors = (c.floors[scope] ??= {});
      for (const [url, at] of Object.entries(floors)) if (at < now() - HISTORY_WINDOW_MS) delete floors[url];
      const mine = (visited[scope] ??= {});
      for (const [url, at] of Object.entries(mine)) if (at < now() - HISTORY_WINDOW_MS) delete mine[url];
      let extracts = 0;
      const state = (c.scopes[scope] ??= emptyScope());
      const adapters            = [
        deviceTabsAdapter(device, input.name, input.tabs ? (tabsOf.get(id) ?? []) : null, false, ghosts),
        sendsAdapter({
          scope,
          sends: () => c.sends,
          acks: () => c.acks,
          drop: (s, keys) => {
            c.sends = dropFrom(c.sends, s, keys);
            c.acks = dropFrom(c.acks, s, keys);
          },
        }),
        ...(ownsData
          ? [
              historyAdapter({
                visits: visitsOf.get(id) ?? [],
                profiles: [...ids].filter((p) => owner.get(p) === id).sort(),
                state,
                floors,
                visited: mine,
                due: (url) => {
                  (c.due [scope] ??= {})[url] = true;
                },
                removed: (p, url) => {
                  const list = (c.removals [p] ??= []);
                  let listed = removing.get(list);
                  if (!listed) removing.set(list, (listed = new Set(list)));
                  if (listed.has(url)) return;
                  listed.add(url);
                  list.push(url);
                },
                ready: () => !!input.visits && (!!c.pulled[scope] || ++extracts > 1),
              }),
              bookmarksAdapter({
                scope,
                state,
                ops: () => c.bookmarks,
                drop: (s, keys) => {
                  c.bookmarks = dropFrom(c.bookmarks, s, keys);
                },
              }),
            ]
          : []),
      ];
      await run(scope, adapters, true);
      if (!Object.keys(floors).length) delete c.floors[scope];
      if (!Object.keys(mine).length) delete visited[scope];
    }
    const fetched = new Set(input.fetchedDue ?? []);
    for (const [scope, urls] of Object.entries(c.due ?? {})) {
      for (const url of Object.keys(urls)) if (fetched.has(url) || !(url in (visited[scope] ?? {}))) delete urls[url];
      if (!Object.keys(urls).length) delete c.due [scope];
    }
  }
  c.clock = clock.last;
  forgetOldSends(c, now());

  const received             = [];
  if (!retiring) {
    const acked = new Set(c.acks.map((a) => `${a.scope}\n${a.key}`));
    const names = new Map([...visible(app, "dev:")].map(([k, v]) => [k.slice(4), typeof (v                   )?.n === "string" ? ((v                 ).n          ) : null]));
    for (const id of liveProfiles(app).keys()) {
      const scope = profileScope(id);
      const state = c.scopes[scope];
      if (!state) continue;
      for (const [k, v] of visible(state, "send:")) {
        const s = v              ;
        if (!s || s.to !== device || s.from === device || acked.has(`${scope}\n${k}`)) continue;
        if (typeof s.u !== "string" || !isWebUrl(s.u)) {
          c.acks.push({ scope, key: k });
          continue;
        }
        received.push({ profile: id, key: k, u: s.u, t: typeof s.t === "string" ? s.t : "", from: String(s.from ?? ""), fromName: names.get(String(s.from)) ?? null, at: Number(s.at) || 0 });
      }
    }
    received.sort((a, z) => a.at - z.at || (a.key < z.key ? -1 : 1));
  }

  const out              = {
    status,
    received,
    historyRemoved: removalsOf(c),
    visitsDue: dueOf(c),
    published,
    changed,
    pending,
    saved: save(published > 0 || changed > 0),
  };
  if (!retiring) {
    const view = buildView(c.scopes, device);
    if (viewIsNew(JSON.stringify(view))) out.view = view;
  }
  return out;
}

function companionView()       {
  const c = loaded();
  const view = buildView(c.scopes, c.device);
  viewIsNew(JSON.stringify(view));
  return view;
}

const scopeFor = (profile        ) => profileScope(dataOwner(loaded().scopes[APP], profile));
const isLive = (profile        ) => liveProfiles(loaded().scopes[APP]).has(profile);
const refused = { saved: false, refused: true }         ;
const SEND_KEY_KEPT_MS = SEND_LIFETIME_MS + DAY_MS;

function forgetOldSends(c                , now        ) {
  const sent = (c.sent ??= {});
  for (const [key, at] of Object.entries(sent)) if (now - at > SEND_KEY_KEPT_MS) delete sent[key];
  return sent;
}

function companionSend(input                                                                                ) {
  const c = loaded();
  if (!isLive(input.profile)) return refused;
  const key = `send:${input.key}`;
  const sent = forgetOldSends(c, input.at);
  const known = key in sent || c.sends.some((s) => s.key === key);
  sent[key] ??= input.at;
  if (!known) {
    c.sends.push({ scope: profileScope(input.profile), key, value: { u: input.u, t: input.t, to: input.to, from: c.device, at: input.at } });
  }
  return { saved: save(true) };
}

function companionRemovalsDone(input                                                  ) {
  const c = loaded();
  for (const { profile, urls } of input.items) {
    const done = new Set(urls);
    const left = (c.removals?.[profile] ?? []).filter((url) => !done.has(url));
    if (left.length) c.removals [profile] = left;
    else delete c.removals?.[profile];
  }
  return { saved: save(true) };
}

function companionAcknowledge(input                                               ) {
  const c = loaded();
  for (const { profile, key } of input.items) {
    const scope = profileScope(profile);
    if (!c.acks.some((a) => a.scope === scope && a.key === key)) c.acks.push({ scope, key });
  }
  return { saved: save(true) };
}

function hasBookmarkFor(c                , scope        , url        ) {
  const removing = new Set(c.bookmarks.filter((o) => o.scope === scope && o.op === "remove").map((o) => `bm:${o.key}`));
  if (c.bookmarks.some((o) => o.scope === scope && o.op === "add" && o.value.u === url)) return true;
  const state = c.scopes[scope];
  if (!state) return false;
  for (const [key, value] of visible(state, "bm:")) {
    const bookmark = value                        ;
    if (!removing.has(key) && bookmark?.k === "u" && typeof bookmark.u === "string" && fromLegacyUrl(bookmark.u) === url) return true;
  }
  return false;
}

function companionAddBookmark(input                                                                    ) {
  const c = loaded();
  if (!isLive(input.profile)) return refused;
  const scope = scopeFor(input.profile);
  if (hasBookmarkFor(c, scope, input.u)) return { saved: true, existing: true };
  if (!c.bookmarks.some((o) => o.scope === scope && o.key === input.key)) {
    c.bookmarks.push({ scope, op: "add", key: input.key, value: { k: "u", p: "other", t: input.t, u: input.u, a: input.at } });
  }
  return { saved: save(true), existing: false };
}

function companionRemoveBookmark(input                                  ) {
  const c = loaded();
  if (!isLive(input.profile)) return refused;
  const scope = scopeFor(input.profile);
  c.bookmarks = c.bookmarks.filter((o) => !(o.scope === scope && o.key === input.key));
  c.bookmarks.push({ scope, op: "remove", key: input.key });
  return { saved: save(true) };
}

});
__define("packages/sync/src/companion/adapters.ts", function (exports, __require) {
  __export(exports, "DAY_MS", () => DAY_MS);
  __export(exports, "HISTORY_WINDOW_MS", () => HISTORY_WINDOW_MS);
  __export(exports, "SEND_LIFETIME_MS", () => SEND_LIFETIME_MS);
  __export(exports, "MAX_DEVICE_TABS", () => MAX_DEVICE_TABS);
  __export(exports, "MAX_VISIT_TIMES", () => MAX_VISIT_TIMES);
  __export(exports, "isWebUrl", () => isWebUrl);
  __export(exports, "historyExpired", () => historyExpired);
  __export(exports, "lastVisitOf", () => lastVisitOf);
  __export(exports, "dayOf", () => dayOf);
  __export(exports, "deviceAdapter", () => deviceAdapter);
  __export(exports, "deviceTabsAdapter", () => deviceTabsAdapter);
  __export(exports, "historyAdapter", () => historyAdapter);
  __export(exports, "sendsAdapter", () => sendsAdapter);
  __export(exports, "bookmarksAdapter", () => bookmarksAdapter);
const { assignPositions } = __require("packages/sync/src/order.ts");
const { hlcWall } = __require("packages/sync/src/hlc.ts");
const { visible } = __require("packages/sync/src/scope.ts");
                                                                                         
                                                            

                                                                    

const DAY_MS = 86_400_000;
const HISTORY_WINDOW_MS = 90 * DAY_MS;
const SEND_LIFETIME_MS = 7 * DAY_MS;
const MAX_DEVICE_TABS = 30;
const MAX_VISIT_TIMES = 50;
const SAME_VISIT_MS = 1;

                                                                                            

                                                                               
                                                                                   

                                                                            
                                                 
                        
                                                                                                   
                                                 

const isWebUrl = (url        ) => /^https?:\/\//i.test(url);

const historyExpired = (key        , value         , now        ) =>
  key.startsWith("h:") && lastVisitOf(value                ) < now - HISTORY_WINDOW_MS;

const lastVisitOf = (v                                 ) => (v && Array.isArray(v.vt) ? v.vt.reduce((m, t) => Math.max(m, t), 0) : 0);

const dayOf = (at        ) => new Date(at).toISOString().slice(0, 10).replaceAll("-", "");

function deviceAdapter(device        , name        , retiring         , ghosts           = [])          {
  const key = `dev:${device}`;
  const old = new Set(ghosts.map((g) => `dev:${g}`));
  return {
    prefix: "dev:",
    extract: (_base, _queued, now) => ({
      values: retiring ? new Map() : new Map([[key, { n: name, k: "phone", f: ["send"], s: dayOf(now) }                      ]]),
      ignore: (k) => k !== key && !old.has(k),
    }),
    apply: () => true,
  };
}

function deviceTabsAdapter(device        , name        , tabs                   , retiring         , ghosts           = [])          {
  const key = `tabs:${device}`;
  const old = new Set(ghosts.map((g) => `tabs:${g}`));
  const ignore = (k        ) => k !== key && !old.has(k);
  return {
    prefix: "tabs:",
    extract: () => {
      if (retiring) return { values: new Map(), ignore };
      if (!tabs) return old.size ? { values: new Map(), ignore: (k) => !old.has(k) } : null;
      const recent = tabs
        .filter((t) => isWebUrl(t.u))
        .sort((a, z) => z.at - a.at)
        .slice(0, MAX_DEVICE_TABS)
        .map((t) => ({ u: t.u, t: t.t }));
      return { values: new Map([[key, { n: name, k: "phone", tabs: recent }                     ]]), ignore };
    },
    apply: () => true,
  };
}

const near = (times          , t        ) => times.some((k) => Math.abs(k - t) <= SAME_VISIT_MS);

function unionTimes(a          , b          )           {
  const out           = [];
  for (const t of [...a, ...b].sort((x, y) => x - y)) if (!out.length || t - out[out.length - 1]  > SAME_VISIT_MS) out.push(t);
  return out.slice(-MAX_VISIT_TIMES);
}

const keptTimes = (times          )           => (times.length > MAX_VISIT_TIMES ? unionTimes(times.filter((t) => Number.isFinite(t)), []) : times);

                       
                                         
                     
                    
                                 
                                  
                             
                                                  
                       
  

function historyAdapter(ctx                )          {
  return {
    prefix: "h:",
    extract: (_base, _queued, now, _known, remote, stamp) => {
      if (!ctx.ready()) return null;
      const since = now - HISTORY_WINDOW_MS;
      const byUrl = new Map                                                                                   ();
      for (const v of ctx.visits) {
        if (!isWebUrl(v.u) || !Array.isArray(v.vt)) continue;
        const entry = byUrl.get(v.u) ?? { title: "", times: [], profiles: new Set(), newest: 0 };
        const times = v.vt.filter((t) => Number.isFinite(t) && t >= since);
        if (!times.length) continue;
        for (const t of times) entry.times.push(t);
        entry.profiles.add(v.p);
        const newest = times.reduce((m, t) => Math.max(m, t), -Infinity);
        if (newest >= entry.newest) {
          entry.newest = newest;
          if (v.t) entry.title = v.t;
        }
        byUrl.set(v.u, entry);
      }
      const values = new Map                 ();
      for (const [url, entry] of byUrl) {
        const key = `h:${url}`;
        const known = remote(key)                                   ;
        if (known === null) {
          const h = stamp(key);
          const deletedAt = Math.min(h ? hlcWall(h) : 0, now);
          if (deletedAt > (ctx.floors[url] ?? -Infinity)) ctx.floors[url] = deletedAt;
        }
        const floor = ctx.floors[url] ?? -Infinity;
        const local = unionTimes([], entry.times.filter((t) => t > floor));
        if (!local.length) {
          for (const p of entry.profiles) ctx.removed(p, url);
          continue;
        }
        if (!known) {
          values.set(key, { t: entry.title, n: local.length, vt: local }                       );
          continue;
        }
        const knownTimes = keptTimes(Array.isArray(known.vt) ? known.vt.filter((t) => Number.isFinite(t)) : []);
        const oldestKept = knownTimes.length >= MAX_VISIT_TIMES ? knownTimes.reduce((m, t) => Math.min(m, t), Infinity) : -Infinity;
        const missing = local.filter((t) => t >= oldestKept && !near(knownTimes, t));
        if (!missing.length) continue;
        const vt = unionTimes(knownTimes, local);
        values.set(key, {
          t: entry.title || (typeof known.t === "string" ? known.t : ""),
          n: Math.max(typeof known.n === "number" ? known.n : 0, local.length, vt.length),
          vt,
        }                       );
      }
      return { values, ignore: (k) => !values.has(k) };
    },
    editedAt: (v) => lastVisitOf(v                ),
    apply: (visible, changed, base, records) => {
      for (const key of changed) {
        const url = key.slice(2);
        const value = visible.get(key)                            ;
        if (value) {
          const mine = ctx.visited[url];
          const times = keptTimes(Array.isArray(value.vt) ? value.vt : []);
          const oldestKept = times.length >= MAX_VISIT_TIMES ? times.reduce((m, t) => Math.min(m, t), Infinity) : -Infinity;
          if (mine !== undefined && mine >= oldestKept && mine > (ctx.floors[url] ?? -Infinity) && !near(times, mine)) ctx.due(url);
          continue;
        }
        const tombstone = ctx.state.records[key];
        const before = base(key)                            ;
        if (!tombstone && before && lastVisitOf(before) < records.now - HISTORY_WINDOW_MS) continue;
        const deletedAt = Math.min(tombstone ? hlcWall(tombstone.h) : records.now, records.now);
        if (deletedAt > (ctx.floors[url] ?? -Infinity)) ctx.floors[url] = deletedAt;
        for (const p of ctx.profiles) ctx.removed(p, url);
      }
      return true;
    },
  };
}

                    
                
                             
                    
                                                   
  

function sendsAdapter(ctx             )          {
  return {
    prefix: "send:",
    extract: (_base, _queued, now, _known, remote) => {
      const values = new Map                 ();
      const tombstones = new Set        ();
      const gone = new Set        ();
      for (const s of ctx.sends()) {
        if (s.scope !== ctx.scope) continue;
        const record = remote(s.key);
        if (record === null) gone.add(s.key);
        else if (now - s.value.at >= SEND_LIFETIME_MS) {
          if (record === undefined) gone.add(s.key);
          else tombstones.add(s.key);
        } else values.set(s.key, s.value);
      }
      for (const a of ctx.acks()) {
        if (a.scope !== ctx.scope) continue;
        const record = remote(a.key);
        if (record === null || record === undefined) gone.add(a.key);
        else tombstones.add(a.key);
      }
      if (gone.size) ctx.drop(ctx.scope, gone);
      return {
        values,
        ignore: (k) => !tombstones.has(k),
        published: (keys) => ctx.drop(ctx.scope, new Set([...keys].filter((k) => tombstones.has(k)))),
      };
    },
    apply: () => true,
  };
}

                        
                
                    
                          
                                                   
  

const sameValue = (a         , b         ) => JSON.stringify(a) === JSON.stringify(b);

function bookmarksAdapter(ctx                 )          {
  return {
    prefix: "bm:",
    extract: (base, _queued, _now, _known, remote) => {
      const ops = ctx.ops().filter((o) => o.scope === ctx.scope);
      if (!ops.length) return { values: new Map(), ignore: () => true };
      const view = visible(ctx.state, "bm:");
      const values = new Map                 ();
      const deletes = new Set        ();
      const settled = new Set        ();
      const children = new Map                  ();
      for (const [k, v] of view) {
        const parent = (v                 ).p;
        if (typeof parent !== "string") continue;
        const list = children.get(parent);
        if (list) list.push(k.slice(3));
        else children.set(parent, [k.slice(3)]);
      }
      const otherPositions = [...view]
        .filter(([, v]) => (v                 ).p === "other" && typeof (v                 ).pos === "string")
        .map(([k, v]) => [(v                 ).pos, k]         )
        .sort((a, z) => (a[0] < z[0] ? -1 : a[0] > z[0] ? 1 : a[1] < z[1] ? -1 : 1))
        .map(([pos]) => pos                      );
      for (const o of ops) {
        const key = `bm:${o.key}`;
        if (o.op === "add") {
          if (o.value.pos === undefined) {
            o.value.pos = assignPositions([...otherPositions, undefined]).at(-1) ;
            otherPositions.push(o.value.pos);
          }
          const record = remote(key);
          if (record !== undefined && (record === null || sameValue(record, o.value))) {
            settled.add(o.key);
            continue;
          }
          values.set(key, o.value);
        } else {
          if (remote(key) === null || remote(key) === undefined || base(key) === undefined) {
            settled.add(o.key);
            continue;
          }
          const stack = [o.key];
          while (stack.length) {
            const at = stack.pop() ;
            if (deletes.has(`bm:${at}`)) continue;
            deletes.add(`bm:${at}`);
            for (const child of children.get(at) ?? []) stack.push(child);
          }
        }
      }
      for (const k of deletes) values.delete(k);
      if (settled.size) ctx.drop(ctx.scope, settled);
      return {
        values,
        ignore: (k) => !values.has(k) && !deletes.has(k),
        published: (keys) => ctx.drop(ctx.scope, new Set([...keys].map((k) => k.slice(3)))),
      };
    },
    apply: () => true,
  };
}

});
__define("packages/sync/src/companion/legacy.ts", function (exports, __require) {
  __export(exports, "fromLegacyUrl", () => fromLegacyUrl);
  __export(exports, "fromLegacy", () => fromLegacy);
const LEGACY_URLS                     = [
  ["netnyahoo://yahu", "ardia://game"],
  ["chrome://yahu", "chrome://game"],
  ["netnyahoo://", "ardia://"],
];

function fromLegacyUrl(url        )         {
  const lower = url.toLowerCase();
  for (const prefix of ["", "view-source:"]) {
    for (const [old, now] of LEGACY_URLS) {
      if (!lower.startsWith(prefix + old)) continue;
      const rest = url.slice(prefix.length + old.length);
      if (!old.endsWith("://") && rest && !"/?#".includes(rest[0] )) continue;
      return url.slice(0, prefix.length) + now + rest;
    }
  }
  return url;
}

function fromLegacy   (value   )    {
  if (typeof value === "string") return fromLegacyUrl(value)     ;
  if (Array.isArray(value)) return value.map(fromLegacy)     ;
  if (value && typeof value === "object") {
    const out                          = {};
    for (const [key, v] of Object.entries(value                           )) out[key] = fromLegacy(v);
    return out     ;
  }
  return value;
}

});
__define("packages/sync/src/companion/view.ts", function (exports, __require) {
  __export(exports, "MAX_HISTORY_ITEMS", () => MAX_HISTORY_ITEMS);
  __export(exports, "liveProfiles", () => liveProfiles);
  __export(exports, "defaultProfileId", () => defaultProfileId);
  __export(exports, "dataOwner", () => dataOwner);
  __export(exports, "pinnedArea", () => pinnedArea);
  __export(exports, "bookmarkTree", () => bookmarkTree);
  __export(exports, "historyList", () => historyList);
  __export(exports, "buildView", () => buildView);
const { visible } = __require("packages/sync/src/scope.ts");
                                                   
const { fromLegacy } = __require("packages/sync/src/companion/legacy.ts");
const { folderChildren } = __require("packages/sync/src/folders.ts");
const { lastVisitOf } = __require("packages/sync/src/companion/adapters.ts");
const { themeOf } = __require("packages/sync/src/companion/theme.ts");

                                            

const MAX_HISTORY_ITEMS = 2_000;
const MAX_BOOKMARK_DEPTH = 100;

                            
                                                                                          

                                                                                                                                 
                                                                                                                   
                                                                                      
                                                                         
                                                                             
                                                                                                                            
                                                                                                                                                            
                                                                                     
                    
                 
               
                       
                      
                     
                          
                        
                               
                                                                     
                            
                         
  
                                                                                                                                              
                                                                                                             
                                                                                                                        

const str = (v         , fallback = "") => (typeof v === "string" ? v : fallback);
const optStr = (v         ) => (typeof v === "string" && v ? v : null);
const kindOf = (v         )       => (v === "phone" ? "phone" : "mac");
const byPosThenKey =                                         (a   , z   ) => (a.pos < z.pos ? -1 : a.pos > z.pos ? 1 : a.key < z.key ? -1 : a.key > z.key ? 1 : 0);

function liveProfiles(app                        )                             {
  const out = new Map                       ();
  if (!app) return out;
  for (const [k, v] of visible(app, "prof:")) if (v && typeof v === "object") out.set(k.slice(5), v                 );
  return out;
}

function defaultProfileId(profiles                            )                {
  const ids = [...profiles.keys()].sort();
  return ids.find((id) => profiles.get(id) .d === true) ?? ids[0] ?? null;
}

function dataOwner(app                        , syncId        )         {
  if (!app) return syncId;
  const profiles = liveProfiles(app);
  const path = [syncId];
  for (let at = syncId; ; ) {
    const owner = (app.records[`share:${at}`]?.v                                      )?.o;
    if (typeof owner !== "string" || owner === at || !profiles.has(owner)) return at;
    const loop = path.indexOf(owner);
    if (loop >= 0) return path.slice(loop).sort()[0] ;
    path.push(owner);
    at = owner;
  }
}

function deviceTabs(scope                        , me        , devices                         )                   {
  if (!scope) return [];
  const out                   = [];
  for (const [k, v] of visible(scope, "tabs:")) {
    const deviceId = k.slice(5);
    const device = devices.get(deviceId);
    const value = v              ;
    if (deviceId === me || !device || !Array.isArray(value?.tabs)) continue;
    const seen = new Set        ();
    const tabs                                   = [];
    for (const t of value.tabs) {
      const url = fromLegacy(str(t?.u));
      const title = str(t?.t);
      if (!url || seen.has(`${url}\n${title}`)) continue;
      seen.add(`${url}\n${title}`);
      tabs.push({ url, title });
    }
    if (!tabs.length) continue;
    out.push({ deviceId, deviceName: device.name || str(value.n) || "Unknown Device", kind: value.k ? kindOf(value.k) : device.kind, tabs });
  }
  return out.sort((a, z) => (devices.get(z.deviceId) .lastSeen ?? 0) - (devices.get(a.deviceId) .lastSeen ?? 0) || (a.deviceId < z.deviceId ? -1 : 1));
}

function sendTargets(scope                        , me        , devices                         )           {
  if (!scope) return [];
  return [...devices.values()]
    .filter((d) => d.id !== me && d.canReceiveTabs && d.id in scope.seen)
    .sort((a, z) => scope.seen[z.id]  - scope.seen[a.id]  || (a.id < z.id ? -1 : 1))
    .map((d) => d.id);
}

                                                                                                    
                                                                                       

function pinnedArea(scope                        )                        {
  if (!scope) return { tiles: [], sections: [] };
  const records = (prefix        ) => visible(scope, prefix);
  const pins = new Map                  ();
  for (const [k, v] of records("pin:t:")) if (v && typeof v === "object") pins.set(k.slice(6), fromLegacy(v            ));
  const groupValues = new Map                   ();
  for (const [k, v] of records("pin:g:")) if (v && typeof v === "object") groupValues.set(k.slice(6), v             );
  const nestValues = new Map                   ();
  for (const [k, v] of records("pinn:g:")) if (v && typeof v === "object") nestValues.set(k.slice(7), v             );
  const rows = new Set([...records("pinrow:")].filter(([, v]) => v === 1).map(([k]) => k.slice(7)));
  const order = records("pord:g:");
  const all = new Set([...groupValues.keys(), ...nestValues.keys()]);
  const parent = new Map                       ();
  for (const id of all) {
    const p = nestValues.get(id)?.p;
    parent.set(id, typeof p === "string" && p !== id && all.has(p) ? p : null);
  }
  for (const start of [...all].sort()) {
    const path           = [];
    for (let at                = start; at; at = parent.get(at) ?? null) {
      const loop = path.indexOf(at);
      if (loop >= 0) {
        parent.set(path.slice(loop).sort()[0] , null);
        break;
      }
      path.push(at);
    }
  }
  const chainUp = (id        ) => {
    const out           = [];
    for (let g                = id; g && !out.includes(g); g = parent.get(g) ?? null) out.push(g);
    return out;
  };
  const groupOf = new Map                       ();
  for (const [key, v] of pins) groupOf.set(key, typeof v.g === "string" && all.has(v.g) ? v.g : null);
  for (const [k, v] of records("pinn:t:")) {
    const key = k.slice(7);
    const inner = (v                   )?.g;
    const g = groupOf.get(key);
    if (!g || typeof inner !== "string" || !all.has(inner)) continue;
    if (chainUp(inner).at(-1) === chainUp(g).at(-1)) groupOf.set(key, inner);
  }
  const tabOf = (key        )                => {
    const v = pins.get(key) ;
    return { key, title: optStr(v.t) ?? str(v.ti), url: str(v.u), icon: optStr(v.i) };
  };
  const pos = (v                               , key        ) => (typeof v?.pos === "string" ? v.pos : `￿${key}`);
  const standalone = [...pins.keys()].filter((k) => groupOf.get(k) === null).map((key) => ({ key, pos: pos(pins.get(key), key) }));
  const roots = [...all].filter((id) => !parent.get(id)).map((key) => ({ key, pos: pos(groupValues.get(key), key) }));
  const areaSlots = [...standalone.map((s) => ({ ...s, group: false })), ...roots.map((r) => ({ ...r, group: true }))].sort(byPosThenKey);

  const kids = new Map                                                                          ();
  const placed = new Set        ();
  const members = [...pins.keys()]
    .filter((k) => groupOf.get(k))
    .map((key) => ({ key, pos: pos(pins.get(key), key), chain: chainUp(groupOf.get(key) ).reverse() }))
    .sort(byPosThenKey);
  for (const m of members) {
    m.chain.forEach((g, i) => {
      if (i === 0 || placed.has(g)) return;
      placed.add(g);
      kids.set(m.chain[i - 1] , [...(kids.get(m.chain[i - 1] ) ?? []), { group: true, key: g }]);
    });
    const leaf = m.chain.at(-1) ;
    kids.set(leaf, [...(kids.get(leaf) ?? []), { group: false, key: m.key }]);
  }
  const lookOf = (id        )            => (parent.get(id) ? (nestValues.get(id) ?? groupValues.get(id)) : (groupValues.get(id) ?? nestValues.get(id))) ?? {};
  const groupView = (id        )                  => {
    const look = lookOf(id);
    return {
      key: id,
      name: str(look.n),
      icon: optStr(look.i),
      color: optStr(look.c),
      items: (kids.get(id) ?? []).map((x) => (x.group ? { group: groupView(x.key) } : { tab: tabOf(x.key) })),
    };
  };

  const folderOf = new Map                ();
  for (const [k, v] of records("tilefold:")) {
    if (k.startsWith("tilefold:n:")) continue;
    const f = (v                   )?.f;
    if (typeof f === "string" && f) folderOf.set(k.slice(9), f);
  }
  const folderName = (id        ) => str((scope.records[`tilefold:n:${id}`]?.v                                      )?.n);
  const tileKeys = areaSlots.filter((s) => !s.group && !rows.has(s.key)).map((s) => s.key);
  const folderMembers = new Map                  ();
  for (const key of tileKeys) {
    const f = folderOf.get(key);
    if (f) folderMembers.set(f, [...(folderMembers.get(f) ?? []), key]);
  }
  const tiles                   = [];
  const emitted = new Set        ();
  for (const key of tileKeys) {
    const f = folderOf.get(key);
    const inFolder = f ? folderMembers.get(f)  : [];
    if (!f || inFolder.length < 2) {
      tiles.push({ ...tabOf(key), folder: null });
      continue;
    }
    if (emitted.has(f)) continue;
    emitted.add(f);
    const tabs = inFolder.map(tabOf);
    tiles.push({ key: `tilefold:${f}`, title: folderName(f) || "Folder", url: tabs[0] .url, icon: null, folder: tabs });
  }

  const blocks = areaSlots.filter((s) => (s.group ? !!kids.get(s.key)?.length : rows.has(s.key)));
  const rowKeys = new Set(blocks.filter((b) => !b.group).map((b) => b.key));
  const anchorOf = (group        ) => {
    const v = order.get(`pord:g:${group}`)                               ;
    if (v === undefined) return undefined;
    return typeof v?.a === "string" ? v.a : null;
  };
  let ordered = blocks;
  if (blocks.some((b) => b.group && anchorOf(b.key) !== undefined)) {
    const placedAfter = new Map                              ();
    const last                = [];
    for (const g of blocks.filter((b) => b.group)) {
      const a = anchorOf(g.key);
      if (a === null || (a !== undefined && rowKeys.has(a))) placedAfter.set(a, [...(placedAfter.get(a) ?? []), g]);
      else last.push(g);
    }
    ordered = [...(placedAfter.get(null) ?? []), ...blocks.filter((b) => !b.group).flatMap((r) => [r, ...(placedAfter.get(r.key) ?? [])]), ...last];
  }
  const sections = ordered.map((b)                    => (b.group ? { group: groupView(b.key) } : { tab: tabOf(b.key) }));
  return { tiles, sections };
}

function bookmarkTree(scope                        )                 {
  if (!scope) return [];
  const values = new Map                       ();
  for (const [k, v] of visible(scope, "bm:")) {
    const b = v                 ;
    if (k !== "bm:bar" && k !== "bm:other" && b && typeof b === "object" && (b.k === "u" || b.k === "f")) values.set(k.slice(3), fromLegacy(b));
  }
  const parentOf = new Map                ();
  for (const [key, v] of values) {
    const p = typeof v.p === "string" ? v.p : "other";
    parentOf.set(key, p === "bar" || p === "other" ? p : values.get(p)?.k === "f" ? p : "other");
  }
  const children = folderChildren(parentOf, [...values.keys()].sort(), "other");
  const sorted = (parent        ) =>
    (children.get(parent) ?? []).map((key) => ({ key, pos: str(values.get(key) .pos) })).sort(byPosThenKey).map((x) => x.key);
  const node = (key        , root                        )               => {
    const v = values.get(key) ;
    const folder = v.k === "f";
    return {
      key,
      title: str(v.t),
      url: folder ? null : str(v.u),
      added: typeof v.a === "number" && Number.isFinite(v.a) ? v.a : 0,
      root,
      children: folder ? [] : null,
    };
  };
  const tree = [...sorted("bar").map((k) => node(k, "bar")), ...sorted("other").map((k) => node(k, "other"))];
  const folders = tree.map((folder) => ({ folder, depth: 1 }));
  while (folders.length) {
    const { folder, depth } = folders.pop() ;
    if (!folder.children || depth >= MAX_BOOKMARK_DEPTH) continue;
    for (const k of sorted(folder.key)) {
      const child = node(k, null);
      folder.children.push(child);
      folders.push({ folder: child, depth: depth + 1 });
    }
  }
  return tree;
}

function historyList(scope                        )                {
  if (!scope) return [];
  const out                = [];
  for (const [k, v] of visible(scope, "h:")) {
    const h = v                ;
    if (!h || typeof h !== "object" || !Array.isArray(h.vt) || !h.vt.length) continue;
    out.push({ url: fromLegacy(k.slice(2)), title: str(h.t), visits: typeof h.n === "number" ? h.n : h.vt.length, lastVisit: lastVisitOf(h) });
  }
  return out.sort((a, z) => z.lastVisit - a.lastVisit || (a.url < z.url ? -1 : 1)).slice(0, MAX_HISTORY_ITEMS);
}

function settingOf(app            , name        )          {
  const record = app.records[`set:${name}`]?.v                                      ;
  return record && typeof record === "object" ? fromLegacy(record.v) : undefined;
}

function oneOf                  (value         , choices              )           {
  return typeof value === "string" && (choices                     ).includes(value) ? (value     ) : null;
}

function lookOf(app            )                  {
  const interfaceStyle = oneOf(settingOf(app, "interfaceStyle"), ["glass", "classic"]         );
  const appearance = oneOf(settingOf(app, "appearance"), ["auto", "light", "dark"]         );
  return interfaceStyle === null && appearance === null ? null : { interfaceStyle, appearance };
}

function searchOf(app            )                    {
  const setting = (name        ) => settingOf(app, name);
  const engine = setting("searchEngine");
  const customUrl = setting("customSearchUrl");
  const custom = setting("customSearchEngines");
  if (engine === undefined && customUrl === undefined && custom === undefined) return null;
  const engines = Array.isArray(custom)
    ? custom
        .filter((e) => e && typeof e === "object" && ["id", "name", "keyword", "url"].every((f) => typeof (e                           )[f] === "string"))
        .map((e) => {
          const { id, name, keyword, url } = e                          ;
          return { id: id , name: name , keyword: keyword , url: url  };
        })
    : [];
  return { engineId: typeof engine === "string" && engine ? engine : "google", customURL: optStr(customUrl), customEngines: engines };
}

function spaceOrder(app            , me        )           {
  let newest                                                        = null;
  for (const [k, v] of visible(app, "dev:")) {
    const id = k.slice(4);
    const stamp = app.records[k]?.h;
    const listed = (v                      )?.o;
    if (id === me || typeof stamp !== "string" || !Array.isArray(listed)) continue;
    const order = [...new Set(listed.filter((profile)                    => typeof profile === "string"))];
    if (!order.length) continue;
    if (!newest || stamp > newest.stamp || (stamp === newest.stamp && id < newest.id)) newest = { stamp, id, order };
  }
  return newest?.order ?? [];
}

function buildView(scopes                            , me        )       {
  const app = scopes.app;
  if (!app) return { devices: [], profiles: [], search: null, look: null };
  const lastSeen = new Map                ();
  for (const scope of Object.values(scopes)) {
    for (const [device, at] of Object.entries(scope.seen)) lastSeen.set(device, Math.max(at, lastSeen.get(device) ?? 0));
  }
  const devices = new Map                    ();
  for (const [k, v] of visible(app, "dev:")) {
    const id = k.slice(4);
    const d = v               ;
    devices.set(id, {
      id,
      name: str(d?.n) || "Unknown Device",
      kind: kindOf(d?.k),
      lastSeen: lastSeen.get(id) ?? null,
      isCurrent: id === me,
      canReceiveTabs: Array.isArray(d?.f) && d.f.includes("send"),
    });
  }
  const deviceList = [...devices.values()].sort((a, z) => Number(z.isCurrent) - Number(a.isCurrent) || (z.lastSeen ?? 0) - (a.lastSeen ?? 0) || (a.id < z.id ? -1 : 1));
  const profiles = liveProfiles(app);
  const defaultId = defaultProfileId(profiles);
  const profileList                = [...profiles].map(([syncId, p]) => {
    const own = scopes[`p:${syncId}`];
    const data = scopes[`p:${dataOwner(app, syncId)}`];
    return {
      syncId,
      name: str(p.n) || "Profile",
      color: optStr(p.c),
      icon: optStr(p.i),
      isDefault: syncId === defaultId,
      theme: themeOf(app, syncId, p.th),
      sendTargets: sendTargets(own, me, devices),
      deviceTabs: deviceTabs(own, me, devices),
      pinned: pinnedArea(own),
      bookmarks: bookmarkTree(data),
      history: historyList(data),
    };
  });
  const rank = new Map(spaceOrder(app, me).map((id, i) => [id, i]));
  const placed = (p             ) => rank.get(p.syncId) ?? rank.size;
  profileList.sort((a, z) => placed(a) - placed(z) || Number(z.isDefault) - Number(a.isDefault) || a.name.localeCompare(z.name) || (a.syncId < z.syncId ? -1 : 1));
  return { devices: deviceList, profiles: profileList, search: searchOf(app), look: lookOf(app) };
}

});
__define("packages/sync/src/folders.ts", function (exports, __require) {
  __export(exports, "folderChildren", () => folderChildren);
function folderChildren(parentOf                     , keys          , fallback        )                        {
  const rooted = new Set        ();
  for (const key of keys) {
    const path = [key];
    const seen = new Set([key]);
    let looped = false;
    for (let at = parentOf.get(key) ; parentOf.has(at) && !rooted.has(at); at = parentOf.get(at) ) {
      if (seen.has(at)) {
        parentOf.set(key, fallback);
        looped = true;
        break;
      }
      seen.add(at);
      path.push(at);
    }
    if (looped) rooted.add(key);
    else for (const at of path) rooted.add(at);
  }
  const children = new Map                  ();
  for (const key of parentOf.keys()) {
    const list = children.get(parentOf.get(key) );
    if (list) list.push(key);
    else children.set(parentOf.get(key) , [key]);
  }
  return children;
}

});
__define("packages/sync/src/companion/theme.ts", function (exports, __require) {
  __export(exports, "themeOf", () => themeOf);
                                                   

                                                                                                     
                                                             
                                                                                                                                                  
                                                                                                                                                            

function hex(n         ) {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  return Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
}

function colorsOf(look         )                  {
  if (!look || typeof look !== "object" || !Array.isArray((look                       ).stops)) return null;
  const out           = [];
  for (const stop of (look                        ).stops.slice(0, 16)) {
    if (out.length >= 3) break;
    const c = (stop                                              )?.color;
    if (!c || ![c.r, c.g, c.b].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 4)) continue;
    const alpha = typeof c.a === "number" && Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1;
    out.push(`#${hex(c.r)}${hex(c.g)}${hex(c.b)}${alpha < 1 ? hex(alpha) : ""}`);
  }
  return out.length ? out : null;
}

const TEXTURES                              = ["grain", "sand", "denim", "tweed"];
const DEFAULT_ANGLE = 135;
const unit = (v         , fallback        ) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const degrees = (v         ) => (typeof v === "number" && Number.isFinite(v) ? ((v % 360) + 360) % 360 : null);

function themeLookOf(look         , angle         )                       {
  if (!look || typeof look !== "object" || !Array.isArray((look                       ).stops)) return null;
  const t = look                           ;
  const stops                  = [];
  for (const raw of (t.stops             ).slice(0, 16)) {
    if (stops.length >= 3) break;
    const s = raw                                  ;
    const c = s?.color                                       ;
    if (!c || ![c.r, c.g, c.b].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 4)) continue;
    stops.push({ color: { r: c.r          , g: c.g          , b: c.b          , a: unit(c.a, 1) }, x: unit(s .x, 0.5), y: unit(s .y, 0.5) });
  }
  if (!stops.length) return null;
  return {
    stops,
    intensity: unit(t.intensity, 0.6),
    grain: unit(t.grain, 0),
    texture: TEXTURES.includes(t.texture                    ) ? (t.texture                    ) : "grain",
    translucency: unit(t.translucency, 1),
    angle: degrees(angle) ?? degrees(t.angle) ?? DEFAULT_ANGLE,
  };
}

function themeOf(app            , syncId        , profileTheme         )                   {
  const record = app.records[`pth:${syncId}`]?.v                                              ;
  const theme = record ? (record.preset === true ? null : record.t) : profileTheme;
  const colors = colorsOf(theme);
  if (!colors) return null;
  const angles = (record ? app.records[`pth:${syncId}:angle`]?.v : null)                                              ;
  const t = theme                           ;
  const look = themeLookOf(theme, angles?.a);
  if (!look) return null;
  const lightAngle = degrees(angles?.a) ?? degrees(t.angle);
  const dark = themeLookOf(t.dark, angles?.d ?? (t.dark                                       )?.angle ?? lightAngle);
  const mode = t.mode === "light" || t.mode === "dark" ? t.mode : "auto";
  return { colors, darkColors: colorsOf(t.dark), mode, look, dark };
}

});
globalThis.ArdiaSync = __require("packages/sync/src/companion/index.ts");
})();
