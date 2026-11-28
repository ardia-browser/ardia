import { documentSaved, readDocument, removeDocument, saveDocument, writeDocument } from "../../platform/documents";
import { Clock, emptyScope, restoreJournal, SyncNative, trackTouchedKeys, writtenSeq, type ApplyBatch, type LogFile, type ScopeState } from "../../platform/sync";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { profileScope } from "./records";
import { APP_SCOPE, DOC, DOC_MIGRATIONS, DOC_VERSION, JOURNAL, STATE, defaultTypes, emptyDoc, type SyncDoc } from "./syncDoc";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { noteMarkSaveRefused, noteStartOverRefused } from "../telemetry/syncSafetyCounts";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { chunksOf, holdsApplying, replayApplying, restOf, type Assembly } from "./applyJournal";
import { addBatches, CHECKPOINT_MIGRATIONS, CHECKPOINT_VERSION, entriesOf, PART_MIGRATIONS, PART_VERSION, readCheckpoint, readPart, replayChanges, type Journal, type JournalPart, type ScopeChange } from "./syncFileFormats";

const STATE_EVERY_MS = 60 * 60_000;
const JOURNAL_BYTES_LIMIT = 1_000_000;
const JOURNAL_PARTS_LIMIT = 400;
const DOC_IDLE_MS = 5 * 60_000;
const APPLYING_HOLD_MS = 2 * 60_000;

const journalPart = (n: number) => `sync-journal-${n}.nns`;

const openSealed = async (sealed: string | null | undefined) => (sealed ? ((await SyncNative?.openLocal(sealed)) ?? null) : null);

export type SessionMarkHooks = {
  moved: (scopes: ScopeState[]) => boolean;
  saved: (rebaseIds: Record<string, string | undefined>) => void;
  docSaved: (doc: SyncDoc, mark: string | undefined) => void;
};

const NO_MARKS: SessionMarkHooks = { moved: () => false, saved: () => {}, docSaved: () => {} };

export function syncFiles(current: () => SyncDoc, marks: SessionMarkHooks = NO_MARKS) {
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
      const checkpoint = readCheckpoint(parseSaved(await openSealed(sealedState), CHECKPOINT_VERSION, CHECKPOINT_MIGRATIONS));
      const parts = await readJournal();
      const doc = current();
      if (doc !== owner) return false;
      const sealedHere = checkpoint.device === doc.deviceId || (checkpoint.device === undefined && !doc.deviceCheckpoints);
      const { scopes, covers, clock: savedClock } = sealedHere ? checkpoint : readCheckpoint(null);
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

  const persistJournal = (scope: string) => (batches: LogFile[]) => {
    const consent = consentToken();
    return serial(async () => {
      await settleReset(consent);
      const list = (journal.batches[scope] ??= []);
      const known = new Set(list.map((f) => f.seq));
      const fresh = batches.filter((file) => !known.has(file.seq));
      if (!fresh.length) return;
      for (const file of fresh) list.push(file);
      try {
        await markBeforeDurable([current().scopes[scope]], consent);
        await writePart({ journal: { [scope]: fresh } });
      } catch (error) {
        const failed = new Set(fresh);
        const left = (journal.batches[scope] ?? []).filter((f) => !failed.has(f));
        if (left.length) journal.batches[scope] = left;
        else delete journal.batches[scope];
        throw error;
      }
    });
  };

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
          await settleReset(consent);
          await markBeforeDurable([scoped], consent);
          await writePart(part);
          writtenRest.set(scope, rest);
          marks.saved({ [scope]: change.rest.rebaseId });
        } catch (error) {
          warnFor(consent, "[sync] couldn't journal this cycle's changes", error);
          state.wanted = true;
        }
      });
    };
  }

  const persistApplying = (scope: string) => (batch: ApplyBatch) => {
    const consent = consentToken();
    const device = current().deviceId;
    const parts = chunksOf(batch).map((chunk) => ({ device, applying: { [scope]: [chunk] } }));
    return serial(async () => {
      await settleReset(consent);
      await markBeforeDurable([current().scopes[scope]], consent);
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

  let markOwed = false;
  let resetOwed: { landed?: () => Promise<void> } | null = null;

  async function markBeforeDurable(scopes: (ScopeState | undefined)[], consent: ConsentToken | null) {
    if (marks.moved(scopes.filter((scoped): scoped is ScopeState => !!scoped))) markOwed = true;
    if (!markOwed) return;
    try {
      await saveDocDurably();
    } catch (error) {
      noteMarkSaveRefused(consent);
      throw error;
    }
  }

  async function saveDocDurably() {
    const doc = current();
    const mark = doc.sessionMark;
    const { json, lasting } = docJson();
    await saveDocument(DOC, json);
    markOwed = false;
    Object.assign(docFile, { json, lasting, savedAt: Date.now() });
    marks.docSaved(doc, mark);
  }

  async function settleReset(consent: ConsentToken | null) {
    while (resetOwed) {
      const owed = resetOwed;
      try {
        await saveDocDurably();
        await saveDocument(STATE, "");
      } catch (error) {
        noteStartOverRefused(consent);
        throw error;
      }
      clearJournal();
      Object.assign(state, { json: "", onDisk: false, wanted: current().enabled });
      if (resetOwed !== owed) continue;
      resetOwed = null;
      await owed.landed?.();
    }
  }

  function docJson() {
    const { scopes, ...meta } = current();
    const seqs = Object.fromEntries(Object.entries(scopes).map(([k, s]) => [k, writtenSeq(s)]));
    return { json: versionedJson({ ...meta, seqs }, DOC_VERSION, "v"), lasting: versionedJson({ ...meta, lastSyncedAt: null, seqs }, DOC_VERSION, "v") };
  }

  function saveDoc() {
    if (resetOwed) return;
    const { json, lasting } = docJson();
    if (json === docFile.json) return;
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
    try {
      await settleReset(consent);
    } catch (error) {
      warnFor(consent, "[sync] couldn't save sync.json to start sync over", error);
      return;
    }
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
    const rebaseIds = Object.fromEntries(Object.entries(doc.scopes).map(([name, scoped]) => [name, scoped.rebaseId]));
    const seen = new Clock("", doc.clock);
    if (state.clock) seen.observe(state.clock.last);
    if (json !== state.json) {
      try {
        await markBeforeDurable(Object.values(doc.scopes), consent);
        const sealed = await SyncNative?.sealLocal(`{"covers":${covers},"clock":${JSON.stringify(seen.last)},"device":${JSON.stringify(doc.deviceId ?? null)},"scopes":${json},"version":${CHECKPOINT_VERSION}}`);
        if (!sealed) return;
        await saveDocument(STATE, sealed);
      } catch (error) {
        warnFor(consent, "[sync] couldn't save the sync state", error);
        return;
      }
      Object.assign(state, { json, onDisk: true });
      marks.saved(rebaseIds);
    }
    state.savedAt = Date.now();
    dropCoveredBatches(seqs);
  }

  function save() {
    saveDoc();
    void serial(saveState);
  }

  async function saveDocNow() {
    if (resetOwed) throw new Error("sync.json hasn't saved since sync started over");
    saveDoc();
    await documentSaved(DOC);
  }

  function startOver(consent: ConsentToken | null, landed?: () => Promise<void>) {
    resetOwed = { landed };
    return serial(async () => {
      await settleReset(consent);
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

  const settleOwedReset = (consent: ConsentToken | null) => serial(() => settleReset(consent));

  return { read, loadState, persistJournal, persistApplying, watchScope, save, saveDocNow, startOver, settleOwedReset, checkpoint };
}
