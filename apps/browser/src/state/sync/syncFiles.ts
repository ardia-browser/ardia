import { readDocument, removeDocument, saveDocument, writeDocument } from "../../platform/documents";
import { Clock, emptyScope, restoreJournal, SyncNative, trackTouchedKeys, writtenSeq, type ApplyBatch, type LogFile, type ScopeState, type SyncRecord } from "../../platform/sync";
import { parseSaved, unchanged, versionedJson, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { profileScope } from "./records";
import { APP_SCOPE, DOC, DOC_MIGRATIONS, DOC_VERSION, JOURNAL, STATE, defaultTypes, emptyDoc, type SyncDoc } from "./syncDoc";
import { isFields, numberOr, stringOr } from "../../lib/decode";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { chunksOf, holdsApplying, replayApplying, restOf, savedScope, scopeFromRest, type Assembly, type ScopeRest } from "./applyJournal";

type Journal = Record<string, LogFile[]>;
type ScopeChange = { records: Record<string, SyncRecord | null>; base: Record<string, string | null>; rest: ScopeRest };
type JournalPart = { id: number; journal?: Journal; device?: string | null; clock?: string; changes?: Record<string, ScopeChange>; applying?: unknown };
type Checkpoint = { covers: number; clock?: string; scopes: SyncDoc["scopes"] };

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_MIGRATIONS: Migrations = { 0: (doc) => (typeof doc.covers === "number" ? doc : { covers: -1, scopes: doc }) };
const PART_VERSION = 1;
const PART_MIGRATIONS: Migrations = { 0: unchanged };

function readScopes(v: unknown): SyncDoc["scopes"] {
  const scopes: SyncDoc["scopes"] = {};
  if (!isFields(v)) return scopes;
  for (const [name, scope] of Object.entries(v)) {
    if (isFields(scope) && isFields(scope.records) && isFields(scope.base)) scopes[name] = savedScope(scope);
  }
  return scopes;
}

function readCheckpoint(doc: SavedObject | null): Checkpoint {
  if (!doc || typeof doc.covers !== "number") return { covers: -1, scopes: {} };
  return { covers: doc.covers, clock: stringOr(doc.clock, undefined), scopes: readScopes(doc.scopes) };
}

function readPart(doc: SavedObject | null): JournalPart {
  if (!doc) return { id: 0 };
  return {
    id: numberOr(doc.id, 0),
    journal: isFields(doc.journal) ? (doc.journal as Journal) : undefined,
    device: stringOr(doc.device, null),
    clock: stringOr(doc.clock, undefined),
    changes: isFields(doc.changes) ? (doc.changes as Record<string, ScopeChange>) : undefined,
    applying: doc.applying,
  };
}

const STATE_EVERY_MS = 60 * 60_000;
const JOURNAL_BYTES_LIMIT = 1_000_000;
const JOURNAL_PARTS_LIMIT = 400;
const DOC_IDLE_MS = 5 * 60_000;
const APPLYING_HOLD_MS = 2 * 60_000;

const journalPart = (n: number) => `sync-journal-${n}.nns`;

const openSealed = async (sealed: string | null | undefined) => (sealed ? ((await SyncNative?.openLocal(sealed)) ?? null) : null);

function addBatches(into: Journal, part: Journal | undefined, added: Map<string, Set<string>>) {
  for (const [scope, files] of Object.entries(part ?? {})) {
    const list = (into[scope] ??= []);
    let ids = added.get(scope);
    if (!ids) added.set(scope, (ids = new Set()));
    for (const file of files) {
      const id = `${file.device}:${file.seq}`;
      if (ids.has(id)) continue;
      ids.add(id);
      list.push(file);
    }
  }
}

function entriesOf<T>(keys: Set<string>, now: Record<string, T>): Record<string, T | null> {
  const entries: Record<string, T | null> = {};
  for (const key of keys) entries[key] = key in now ? now[key]! : null;
  return entries;
}

function replayChanges(scopes: SyncDoc["scopes"], changes: Record<string, ScopeChange>, live: Set<string>) {
  for (const [scope, change] of Object.entries(changes)) {
    if (!live.has(scope)) continue;
    const before = scopes[scope];
    const { records, base } = before ?? emptyScope();
    for (const [key, record] of Object.entries(change.records)) {
      if (record) records[key] = record;
      else delete records[key];
    }
    for (const [key, json] of Object.entries(change.base)) {
      if (json !== null) base[key] = json;
      else delete base[key];
    }
    scopes[scope] = scopeFromRest(change.rest, records, base, before);
  }
}

export function syncFiles(current: () => SyncDoc) {
  const docFile = { json: "", lasting: "", savedAt: 0 };
  const journal = { batches: {} as Journal, parts: null as number | null, bytes: 0, legacy: false, lastId: 0 };
  const state = { json: "", onDisk: false, loaded: false, savedAt: 0, wanted: false, clock: null as Clock | null, heldSince: undefined as number | undefined };
  const writtenRest = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function read(): SyncDoc | null {
    try {
      const json = readDocument(DOC);
      const saved = parseSaved(json, DOC_VERSION, DOC_MIGRATIONS, "v") as SyncDoc | null;
      const loaded = saved ? { ...emptyDoc(), ...saved, types: { ...defaultTypes(), ...saved.types }, scopes: {} } : null;
      docFile.json = json ?? "";
      return loaded;
    } catch (error) {
      console.warn("[sync] couldn't read sync.json", error);
      return null;
    }
  }

  async function readJournal() {
    const found: JournalPart[] = [];
    const take = async (sealed: string | null) => void found.push(readPart(parseSaved(await openSealed(sealed), PART_VERSION, PART_MIGRATIONS)));
    const legacy = readDocument(JOURNAL);
    journal.legacy = !!legacy;
    journal.bytes = legacy?.length ?? 0;
    await take(legacy);
    journal.parts = 0;
    for (let n = 1; ; n++) {
      const part = readDocument(journalPart(n));
      if (!part) break;
      journal.parts = n;
      journal.bytes += part.length;
      await take(part);
    }
    return found;
  }

  const loadState = (owner = current()) =>
    serial(async () => {
      const sealedState = readDocument(STATE);
      const { scopes, covers, clock: savedClock } = readCheckpoint(parseSaved(await openSealed(sealedState), CHECKPOINT_VERSION, CHECKPOINT_MIGRATIONS));
      const parts = await readJournal();
      const doc = current();
      if (doc !== owner) return false;
      const live = new Set([APP_SCOPE, ...Object.values(doc.profiles).map((link) => profileScope(link.syncId))]);
      const clock = new Clock(doc.deviceId ?? "", doc.clock);
      if (savedClock) clock.observe(savedClock);
      const batches: Journal = {};
      const added = new Map<string, Set<string>>();
      const assembly: Assembly = new Map();
      journal.lastId = Math.max(covers, 0);
      for (const part of parts) {
        journal.lastId = Math.max(journal.lastId, part.id);
        if (part.id <= covers) continue;
        addBatches(batches, part.journal, added);
        if ((!part.changes && !part.applying) || part.device !== doc.deviceId) continue;
        if (part.clock) clock.observe(part.clock);
        if (part.changes) replayChanges(scopes, part.changes, live);
        if (part.applying) replayApplying(scopes, part.applying, live, assembly);
      }
      journal.batches = {};
      for (const [scope, files] of Object.entries(batches)) {
        const mine = files.filter((f) => f.device === doc.deviceId);
        if (mine.length) journal.batches[scope] = mine;
      }
      for (const scope of new Set([...Object.keys(doc.seqs ?? {}), ...Object.keys(journal.batches)])) {
        restoreJournal((scopes[scope] ??= emptyScope()), journal.batches[scope] ?? [], clock, doc.seqs?.[scope]);
      }
      for (const scoped of Object.values(scopes)) for (const key in scoped.records) clock.observe(scoped.records[key]!.h);
      if (doc.deviceId) doc.clock = clock.last;
      doc.scopes = scopes;
      writtenRest.clear();
      for (const [scope, scoped] of Object.entries(scopes)) writtenRest.set(scope, JSON.stringify(restOf(scoped)));
      Object.assign(state, { json: "", onDisk: !!sealedState, loaded: true, savedAt: Date.now() });
      return true;
    });

  function countedParts() {
    if (journal.parts === null) {
      let n = 0;
      while (readDocument(journalPart(n + 1))) n++;
      journal.parts = n;
    }
    return journal.parts;
  }

  async function writePart(part: Omit<JournalPart, "id">) {
    const id = (journal.lastId = Math.max(journal.lastId + 1, Date.now()));
    const sealed = await SyncNative!.sealLocal(versionedJson({ ...part, id }, PART_VERSION));
    const n = countedParts() + 1;
    await saveDocument(journalPart(n), sealed);
    journal.parts = n;
    journal.bytes += sealed.length;
  }

  const persistJournal = (scope: string) => (batches: LogFile[]) =>
    serial(async () => {
      const list = (journal.batches[scope] ??= []);
      const known = new Set(list.map((f) => f.seq));
      const fresh = batches.filter((file) => !known.has(file.seq));
      if (!fresh.length) return;
      for (const file of fresh) list.push(file);
      try {
        await writePart({ journal: { [scope]: fresh } });
      } catch (error) {
        const failed = new Set(fresh);
        const left = (journal.batches[scope] ?? []).filter((f) => !failed.has(f));
        if (left.length) journal.batches[scope] = left;
        else delete journal.batches[scope];
        throw error;
      }
    });

  function watchScope(scope: string, scoped: ScopeState, clock: Clock) {
    const consent = consentToken();
    state.clock = clock;
    const { touched: keys, stop } = trackTouchedKeys(scoped);
    return () => {
      stop();
      if (current().scopes[scope] !== scoped) return Promise.resolve();
      const change: ScopeChange = { records: entriesOf(keys.records, scoped.records), base: entriesOf(keys.base, scoped.base), rest: restOf(scoped) };
      const touched = keys.records.size > 0 || keys.base.size > 0;
      const rest = JSON.stringify(change.rest);
      if (!touched && rest === writtenRest.get(scope)) return Promise.resolve();
      const part = { device: current().deviceId, clock: clock.last, changes: { [scope]: change } };
      return serial(async () => {
        try {
          await writePart(part);
          writtenRest.set(scope, rest);
        } catch (error) {
          warnFor(consent, "[sync] couldn't journal this cycle's changes", error);
          state.wanted = true;
        }
      });
    };
  }

  const persistApplying = (scope: string) => (batch: ApplyBatch) => {
    const device = current().deviceId;
    const parts = chunksOf(batch).map((chunk) => ({ device, applying: { [scope]: [chunk] } }));
    return serial(async () => {
      for (const part of parts) await writePart(part);
    });
  };

  function clearJournal() {
    journal.batches = {};
    for (let n = countedParts(); n > 0; n--) removeDocument(journalPart(n));
    if (journal.legacy) writeDocument(JOURNAL, "");
    Object.assign(journal, { parts: 0, bytes: 0, legacy: false });
  }

  function dropCoveredBatches(seqs: Record<string, number>) {
    for (const [scope, list] of Object.entries(journal.batches)) {
      const left = list.filter((f) => f.seq > (seqs[scope] ?? 0));
      if (left.length) journal.batches[scope] = left;
      else delete journal.batches[scope];
    }
    if (!Object.keys(journal.batches).length) clearJournal();
  }

  function saveDoc() {
    const { scopes, ...meta } = current();
    const seqs = Object.fromEntries(Object.entries(scopes).map(([k, s]) => [k, writtenSeq(s)]));
    const json = versionedJson({ ...meta, seqs }, DOC_VERSION, "v");
    if (json === docFile.json) return;
    const lasting = versionedJson({ ...meta, lastSyncedAt: null, seqs }, DOC_VERSION, "v");
    const now = Date.now();
    if (lasting === docFile.lasting && now - docFile.savedAt < DOC_IDLE_MS) return;
    Object.assign(docFile, { json, lasting, savedAt: now });
    writeDocument(DOC, json);
  }

  function stateDue() {
    if (state.wanted) return true;
    if (!state.loaded) return false;
    if (holdsApplying(current().scopes) && Date.now() - (state.heldSince ??= Date.now()) < APPLYING_HOLD_MS) return false;
    state.heldSince = undefined;
    return countedParts() >= JOURNAL_PARTS_LIMIT || journal.bytes >= JOURNAL_BYTES_LIMIT || Date.now() - state.savedAt >= STATE_EVERY_MS;
  }

  async function saveState() {
    const consent = consentToken();
    const doc = current();
    if (!doc.enabled) {
      if (state.onDisk || state.wanted) writeDocument(STATE, "");
      Object.assign(state, { json: "", onDisk: false, wanted: false });
      return;
    }
    if (!stateDue()) return;
    state.wanted = false;
    state.loaded = true;
    const covers = journal.lastId;
    const seqs = Object.fromEntries(Object.entries(doc.scopes).map(([k, s]) => [k, s.seq]));
    const json = JSON.stringify(doc.scopes);
    const seen = new Clock("", doc.clock);
    if (state.clock) seen.observe(state.clock.last);
    if (json !== state.json) {
      try {
        const sealed = await SyncNative?.sealLocal(`{"covers":${covers},"clock":${JSON.stringify(seen.last)},"scopes":${json},"version":${CHECKPOINT_VERSION}}`);
        if (!sealed) return;
        await saveDocument(STATE, sealed);
      } catch (error) {
        warnFor(consent, "[sync] couldn't save the sync state", error);
        return;
      }
      Object.assign(state, { json, onDisk: true });
    }
    state.savedAt = Date.now();
    dropCoveredBatches(seqs);
  }

  function save() {
    saveDoc();
    void serial(saveState);
  }

  function startOver() {
    saveDoc();
    void serial(async () => {
      clearJournal();
      state.wanted = true;
      await saveState();
    });
  }

  function checkpoint() {
    saveDoc();
    return serial(async () => {
      if (state.loaded && current().enabled) state.wanted = true;
      await saveState();
    });
  }

  return { read, loadState, persistJournal, persistApplying, watchScope, save, startOver, checkpoint };
}
