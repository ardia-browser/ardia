import { isBaseEntry, isLogFile, isSequence, isStamp, isSyncOp, isSyncRecord, type ScopeState } from "../../platform/sync";
import { isFields } from "../../lib/decode";
import type { SyncDoc } from "./syncDoc";
import type { JournalPart } from "./syncFiles";

export class SyncStateDamaged extends Error {
  readonly code = "ERR_SYNC_STATE_DAMAGED";
  readonly where: string;
  constructor(where: string) {
    super(`Sync's saved state is damaged (${where})`);
    this.name = "SyncStateDamaged";
    this.where = where;
  }
}

type Valid = (item: unknown) => boolean;

const everyValue = (v: unknown, valid: Valid) => isFields(v) && Object.values(v).every(valid);
const listOf = (v: unknown, valid: Valid) => Array.isArray(v) && v.every(valid);
const orAbsent = (valid: Valid) => (v: unknown) => v === undefined || valid(v);
const orDeleted = (valid: Valid) => (v: unknown) => v === null || valid(v);
const isTime = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown) => typeof v === "string";

const isStampedRecord = (v: unknown) => isSyncRecord(v) && isStamp(v.h);
const isStampedOp = (v: unknown) => isSyncOp(v) && isStamp(v.h);
const isStampedLog = (v: unknown) => isLogFile(v) && v.ops.every(isStampedOp);
const hasStamp = (v: unknown) => isFields(v) && isStamp(v.h);

const BOOKKEEPING: [keyof ScopeState, Valid][] = [
  ["seq", isSequence],
  ["journal", (v) => listOf(v, isStampedLog)],
  ["outbox", (v) => listOf(v, isStampedOp)],
  ["vv", (v) => everyValue(v, isSequence)],
  ["extra", (v) => everyValue(v, (list) => listOf(list, isSequence))],
  ["unapplied", (v) => listOf(v, isText)],
];

const CYCLE_MAPS: [keyof ScopeState, Valid][] = [
  ["seen", (v) => everyValue(v, isTime)],
  ["files", (v) => everyValue(v, (meta) => isFields(meta) && isText(meta.k))],
  ["damaged", (v) => everyValue(v, isTime)],
  ["applyAs", (v) => everyValue(v, isText)],
  ["pendingSince", (v) => everyValue(v, isTime)],
];

const SEEN = CYCLE_MAPS.slice(0, 1);

function firstBad(fields: Partial<ScopeState>, checks: [keyof ScopeState, Valid][]): string | null {
  for (const [field, valid] of checks) if (!orAbsent(valid)(fields[field])) return `its ${field}`;
  return null;
}

function liveScopeDamage(scoped: ScopeState): string | null {
  if (!everyValue(scoped.records, isStampedRecord)) return "a record";
  if (!everyValue(scoped.base, isBaseEntry)) return "a base entry";
  return firstBad(scoped, [...BOOKKEEPING, ...CYCLE_MAPS]);
}

function unlinkedScopeDamage(scoped: ScopeState, restored: boolean): string | null {
  if (!everyValue(scoped.records, hasStamp)) return "a record's stamp";
  return firstBad(scoped, restored ? [...SEEN, ...BOOKKEEPING] : SEEN);
}

function changeDamage(change: unknown): string | null {
  if (!isFields(change) || !isFields(change.rest)) return "a change";
  if (!everyValue(change.records, orDeleted(isStampedRecord))) return "a changed record";
  if (!everyValue(change.base, orDeleted(isBaseEntry))) return "a changed base entry";
  return firstBad(change.rest as Partial<ScopeState>, [...BOOKKEEPING, ...CYCLE_MAPS]);
}

export type SavedStateRead = {
  scopes: SyncDoc["scopes"];
  parts: JournalPart[];
  covers: number;
  checkpointMalformed?: string;
  clock?: string;
  device: string | null;
  live: Set<string>;
  seqs: unknown;
};

function batchDamage(parts: JournalPart[], covers: number, device: string | null, restored: Set<string>): string | null {
  for (const part of parts) {
    if (part.id <= covers) continue;
    if (part.malformed) return `its ${part.malformed} in a journal part`;
    for (const [name, files] of Object.entries(part.journal ?? {})) {
      if (!listOf(files, isFields)) return "a batch in a journal part";
      const mine = (files as Record<string, unknown>[]).filter((file) => file.device === device);
      if (!mine.every(isStampedLog)) return "a batch in a journal part";
      if (mine.length) restored.add(name);
    }
  }
  return null;
}

function changesDamage(parts: JournalPart[], covers: number, device: string | null, live: Set<string>): string | null {
  for (const part of parts) {
    if (part.id <= covers || !part.changes || part.device !== device) continue;
    if (part.clock !== undefined && !isStamp(part.clock)) return "its clock in a journal part";
    for (const [name, change] of Object.entries(part.changes)) {
      const damage = live.has(name) ? changeDamage(change) : null;
      if (damage) return `${damage} in a journal part`;
    }
  }
  return null;
}

export function savedStateDamage({ scopes, parts, covers, checkpointMalformed, clock, device, live, seqs }: SavedStateRead): string | null {
  if (checkpointMalformed) return `its ${checkpointMalformed} in the checkpoint`;
  if (clock !== undefined && !isStamp(clock)) return "its clock in the checkpoint";
  if (!orAbsent((v) => everyValue(v, isSequence))(seqs)) return "a sequence number in sync.json";
  const restored = new Set(Object.keys(isFields(seqs) ? seqs : {}));
  const batches = batchDamage(parts, covers, device, restored);
  if (batches) return batches;
  for (const [name, scoped] of Object.entries(scopes)) {
    const damage = live.has(name) ? liveScopeDamage(scoped) : unlinkedScopeDamage(scoped, restored.has(name));
    if (damage) return `${damage} in ${live.has(name) ? "a linked" : "an unlinked"} scope of the checkpoint`;
  }
  return changesDamage(parts, covers, device, live);
}
