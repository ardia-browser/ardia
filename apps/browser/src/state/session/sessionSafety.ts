import { copyDocument, createDocument, documentExists, listDocuments, readDocument, removeDocument, syncDocument } from "../../platform/documents";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { isFields } from "../../lib/decode";
import { readSaved, readSavedValue, type Migrations, type SavedObject, type SavedProblem } from "../../lib/savedDocument";

type UnusableReason = SavedProblem | "unreadable" | "rows";
export type FoundDocument =
  | { state: "missing" }
  | { state: "usable"; text: string; doc: SavedObject; from: number }
  | { state: "unusable"; reason: UnusableReason; text: string | null }
  | { state: "unknown"; exists: Promise<boolean> };

export const fromNewerBuild = (found: FoundDocument) => found.state === "unusable" && found.reason === "newer";

export function findDocument(name: string, version: number, migrations: Migrations, whole: (doc: SavedObject) => boolean = () => true): FoundDocument {
  let text: unknown = null;
  try {
    text = readDocument(name);
  } catch {
    text = null;
  }
  if (typeof text === "string") {
    const read = readSaved(text, version, migrations);
    if (!("doc" in read)) return { state: "unusable", reason: read.problem, text };
    return whole(read.doc) ? { state: "usable", text, doc: read.doc, from: read.from } : { state: "unusable", reason: "shape", text };
  }
  let exists: boolean | Promise<boolean>;
  try {
    exists = documentExists(name);
  } catch {
    exists = true;
  }
  if (exists === false) return { state: "missing" };
  if (exists === true) return { state: "unusable", reason: "unreadable", text: null };
  return { state: "unknown", exists: Promise.resolve(exists).then((found) => found !== false, () => true) };
}

const listOrAbsent = (value: unknown) => value === undefined || Array.isArray(value);
const fieldsOrAbsent = (value: unknown) => value === undefined || isFields(value);

const SESSION_LISTS = ["windows", "tabs", "groups", "splits", "windowOrder", "profileOrder"];
const SESSION_OBJECTS = ["profiles", "settings", "parkedPins"];

export const wholeSession = (doc: SavedObject) =>
  [...SESSION_LISTS, ...SESSION_OBJECTS].some((key) => doc[key] !== undefined) &&
  SESSION_LISTS.every((key) => listOrAbsent(doc[key])) &&
  SESSION_OBJECTS.every((key) => fieldsOrAbsent(doc[key]));

export const wholeDownloads = (doc: SavedObject) => Array.isArray(doc.downloads);

export function usableSessionValue(value: unknown, version: number, migrations: Migrations): SavedObject | null {
  const read = readSavedValue(value, version, migrations);
  return "doc" in read && wholeSession(read.doc) ? read.doc : null;
}

let asideCount = 0;

const asideName = (name: string, now = Date.now()) => `${name.replace(/\.json$/, "")}-unreadable-${now}-${++asideCount}.json`;

function keepCopy(name: string, copy: string): Promise<void> {
  try {
    return Promise.resolve(copyDocument(name, copy));
  } catch (error) {
    return Promise.reject(error);
  }
}

type WriteCheck = { hold: false } | { hold: true; againIn: number | null };
export type WriteGate = { check: () => WriteCheck; landing: () => Promise<void> | null; open: () => boolean; tryNow: () => void };

const GATE_RETRY_MS = 2_000;
const MAX_GATE_RETRY_MS = 60_000;
const GATE_TIMEOUT_MS = 30_000;
const OPEN: WriteCheck = { hold: false };
const monotonicNow = () => performance.now();

function bounded(attempt: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, GATE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([attempt, waited]).finally(() => clearTimeout(timer));
}

export function writeGate(task: () => Promise<void>, saveAgain: (delay: number) => void, failed: () => void = () => {}): WriteGate {
  let open = false;
  let running: Promise<void> | null = null;
  let landing: Promise<void> | null = null;
  let failures = 0;
  let againAt = 0;
  const start = () => {
    let attempt: Promise<void>;
    try {
      attempt = task();
    } catch (error) {
      attempt = Promise.reject(error);
    }
    const mine: Promise<void> = attempt.then(
      () => {
        open = true;
        running = null;
        saveAgain(0);
      },
      () => {
        running = null;
        failures++;
        failed();
        const delay = Math.min(MAX_GATE_RETRY_MS, GATE_RETRY_MS * 2 ** (failures - 1));
        againAt = monotonicNow() + delay;
        saveAgain(delay);
      },
    );
    running = mine;
    const waiting: Promise<void> = bounded(mine).then(() => {
      if (landing === waiting) landing = null;
    });
    landing = waiting;
  };
  start();
  return {
    check: () => {
      if (open) return OPEN;
      if (running) return { hold: true, againIn: null };
      const wait = againAt - monotonicNow();
      if (wait > 0) return { hold: true, againIn: wait };
      start();
      return { hold: true, againIn: null };
    },
    landing: () => (open ? null : landing),
    open: () => open,
    tryNow: () => {
      if (!open && !running) start();
    },
  };
}

const documentGone = (error: unknown) => isFields(error) && error.code === "ERR_DOCUMENT_GONE";

export function keepAsideGate(
  name: string,
  found: FoundDocument,
  saveAgain: (delay: number) => void,
  noted: { unreadable: () => void; failed: () => void },
  recreate: () => Promise<void>,
): WriteGate | null {
  if (found.state !== "unusable" && found.state !== "unknown") return null;
  const aside = asideName(name);
  const keepOrRecreate = () => keepCopy(name, aside).catch((error: unknown) => (documentGone(error) ? recreate() : Promise.reject(error)));
  if (found.state === "unusable") return writeGate(keepOrRecreate, saveAgain, noted.failed);
  let counted = false;
  const keep = () =>
    found.exists.then((exists) => {
      if (!exists) return;
      if (!counted) noted.unreadable();
      counted = true;
      return keepOrRecreate();
    });
  return writeGate(keep, saveAgain, noted.failed);
}

export const DAILY_BACKUP = "session-backup-";
export const MIGRATION_BACKUP = "session-premigration-";
const DAILY_BACKUPS_KEPT = 7;
const MIGRATION_BACKUPS_KEPT = 3;
export const BACKUP_EVERY_MS = 24 * 60 * 60_000;
export const BACKUP_RETRY_MS = 5 * 60_000;
const CREATE_ATTEMPTS = 5;

type BackupName = { name: string; seq: number };
type BackupFile = BackupName & { at: number; session: unknown };

const SEQ = /^(\d{1,16})\.json$/;

function backupNames(prefix: string): BackupName[] {
  let names: unknown = [];
  try {
    names = listDocuments(prefix);
  } catch {
    names = [];
  }
  if (!Array.isArray(names)) return [];
  return names.flatMap((name) => {
    if (typeof name !== "string" || !name.startsWith(prefix)) return [];
    const seq = SEQ.exec(name.slice(prefix.length));
    return seq ? [{ name, seq: Number(seq[1]) }] : [];
  });
}

export const backupJson = (at: number, sessionJson: string) => `{"backupAt":${Math.round(at)},"session":${sessionJson}}`;

function readBackup({ name, seq }: BackupName): BackupFile | null {
  let text: unknown = null;
  try {
    text = readDocument(name);
  } catch {
    return null;
  }
  if (typeof text !== "string" || !text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isFields(raw) || !isFields(raw.session) || typeof raw.backupAt !== "number" || !Number.isFinite(raw.backupAt)) return null;
  return { name, seq, at: raw.backupAt, session: raw.session };
}

const plausible = (at: number, now: number) => at <= now + BACKUP_EVERY_MS;

function orderedBackups(prefixes: readonly string[], now = Date.now()): BackupFile[] {
  const files = prefixes.flatMap(backupNames).map(readBackup).filter((b): b is BackupFile => b !== null);
  return files.sort((a, b) => Number(plausible(b.at, now)) - Number(plausible(a.at, now)) || b.at - a.at || b.seq - a.seq);
}

export type RestoredBackup<T> = { value: T; name: string; at: number; ageDays: number };

export function sessionBackups<T>(parse: (doc: SavedObject) => T | null, version: number, migrations: Migrations, now = Date.now()): RestoredBackup<T>[] {
  const usable: RestoredBackup<T>[] = [];
  for (const backup of orderedBackups([DAILY_BACKUP, MIGRATION_BACKUP], now)) {
    const doc = usableSessionValue(backup.session, version, migrations);
    if (!doc) continue;
    let value: T | null = null;
    try {
      value = parse(doc);
    } catch {
      value = null;
    }
    if (value !== null) usable.push({ value, name: backup.name, at: backup.at, ageDays: Math.max(0, Math.floor((now - backup.at) / BACKUP_EVERY_MS)) });
  }
  return usable;
}

type RollingBackups = { afterSave: (sessionJson: string, now?: number) => void; beforeMigration: (sessionText: string, now?: number) => Promise<void> };
type BackupRules = { whole: (session: unknown) => boolean; recovering: () => boolean; written: (beforeMigration: boolean, consent: ConsentToken | null) => void };

const nextSeq = (prefix: string) => backupNames(prefix).reduce((top, b) => Math.max(top, b.seq), 0) + 1;

function createOnce(name: string, json: string): Promise<void> {
  try {
    return Promise.resolve(createDocument(name, json));
  } catch (error) {
    return Promise.reject(error);
  }
}

const nameTaken = (error: unknown) => isFields(error) && error.code === "ERR_DOCUMENT_EXISTS";

async function createFresh(prefix: string, json: string, first = nextSeq(prefix)): Promise<string> {
  let seq = first;
  for (let attempt = 1; ; attempt++) {
    const name = `${prefix}${seq}.json`;
    try {
      await createOnce(name, json);
      return name;
    } catch (error) {
      if (!nameTaken(error) || attempt >= CREATE_ATTEMPTS) throw error;
      seq = Math.max(seq + 1, nextSeq(prefix));
    }
  }
}

function retentionOrder(prefix: string, now: number): BackupName[] {
  const parsed = orderedBackups([prefix], now);
  const seen = new Set(parsed.map((b) => b.name));
  const malformed = backupNames(prefix)
    .filter((b) => !seen.has(b.name))
    .sort((a, b) => b.seq - a.seq);
  return [...parsed, ...malformed];
}

export function rollingBackups(rules: BackupRules): RollingBackups {
  let writing = false;
  let nextCheckAt = 0;
  let lastNow = 0;
  let epoch = 0;
  let retryAt = 0;
  let migration: { name: string; json: string } | null = null;
  const prune = (prefix: string, kept: number, written: string, now: number) => {
    if (rules.recovering()) return;
    const parsed = orderedBackups([prefix], now);
    const newestWhole = parsed.find((b) => plausible(b.at, now) && rules.whole(b.session))?.name ?? parsed.find((b) => rules.whole(b.session))?.name;
    for (const { name } of retentionOrder(prefix, now).slice(kept)) {
      if (name === written || name === newestWhole) continue;
      try {
        removeDocument(name);
      } catch {
        continue;
      }
    }
  };
  const landed = (prefix: string, kept: number, name: string, now: number, beforeMigration: boolean, consent: ConsentToken | null) => {
    writing = false;
    rules.written(beforeMigration, consent);
    prune(prefix, kept, name, now);
  };
  const failed = (error: unknown) => {
    writing = false;
    retryAt = monotonicNow() + BACKUP_RETRY_MS;
    throw error;
  };
  return {
    afterSave: (sessionJson, now = Date.now()) => {
      if (now < lastNow) {
        nextCheckAt = 0;
        epoch++;
      }
      lastNow = now;
      if (writing || now < nextCheckAt || monotonicNow() < retryAt) return;
      const recent = orderedBackups([DAILY_BACKUP], now).find((b) => Math.abs(now - b.at) < BACKUP_EVERY_MS && rules.whole(b.session));
      if (recent) {
        nextCheckAt = now + BACKUP_EVERY_MS - Math.abs(now - recent.at);
        return;
      }
      const consent = consentToken();
      const started = epoch;
      writing = true;
      void createFresh(DAILY_BACKUP, backupJson(now, sessionJson))
        .then((name) => landed(DAILY_BACKUP, DAILY_BACKUPS_KEPT, name, now, false, consent), failed)
        .then(
          () => {
            if (started === epoch) nextCheckAt = now + BACKUP_EVERY_MS;
          },
          () => {},
        );
    },
    beforeMigration: (sessionText, now = Date.now()) => {
      const consent = consentToken();
      migration ??= { name: `${MIGRATION_BACKUP}${nextSeq(MIGRATION_BACKUP)}.json`, json: backupJson(now, sessionText.trim()) };
      const reserved = migration;
      writing = true;
      const seqOf = (name: string) => Number(SEQ.exec(name.slice(MIGRATION_BACKUP.length))?.[1] ?? 0);
      const attempt = async (): Promise<string> => {
        for (let tries = 1; ; tries++) {
          let held: unknown = null;
          try {
            held = readDocument(reserved.name);
          } catch {
            held = null;
          }
          if (held === reserved.json) {
            await syncDocument(reserved.name);
            return reserved.name;
          }
          try {
            await createOnce(reserved.name, reserved.json);
            return reserved.name;
          } catch (error) {
            if (!nameTaken(error) || tries >= CREATE_ATTEMPTS * 4) throw error;
            reserved.name = `${MIGRATION_BACKUP}${Math.max(seqOf(reserved.name) + 1, nextSeq(MIGRATION_BACKUP))}.json`;
          }
        }
      };
      return attempt().then((landedName) => landed(MIGRATION_BACKUP, MIGRATION_BACKUPS_KEPT, landedName, now, true, consent), failed);
    },
  };
}
