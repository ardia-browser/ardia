import { emptyScope, type LogFile, type SyncRecord } from "../../platform/sync";
import { unchanged, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { isFields, numberOr, stringOr } from "../../lib/decode";
import { savedScope, scopeFromRest, type ScopeRest } from "./applyJournal";
import type { SyncDoc } from "./syncDoc";

export type Journal = Record<string, LogFile[]>;
export type ScopeChange = { records: Record<string, SyncRecord | null>; base: Record<string, string | null>; rest: ScopeRest };
export type JournalPart = { id: number; journal?: Journal; device?: string | null; clock?: string; changes?: Record<string, ScopeChange>; applying?: unknown };
type Checkpoint = { covers: number; clock?: string; device?: string; scopes: SyncDoc["scopes"] };

export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_MIGRATIONS: Migrations = { 0: (doc) => (typeof doc.covers === "number" ? doc : { covers: -1, scopes: doc }) };
export const PART_VERSION = 1;
export const PART_MIGRATIONS: Migrations = { 0: unchanged };

function readScopes(v: unknown): SyncDoc["scopes"] {
  const scopes: SyncDoc["scopes"] = {};
  if (!isFields(v)) return scopes;
  for (const [name, scope] of Object.entries(v)) {
    if (isFields(scope) && isFields(scope.records) && isFields(scope.base)) scopes[name] = savedScope(scope);
  }
  return scopes;
}

export function readCheckpoint(doc: SavedObject | null): Checkpoint {
  if (!doc || typeof doc.covers !== "number") return { covers: -1, scopes: {} };
  return { covers: doc.covers, clock: stringOr(doc.clock, undefined), device: stringOr(doc.device, undefined), scopes: readScopes(doc.scopes) };
}

export function readPart(doc: SavedObject | null): JournalPart {
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

export function addBatches(into: Journal, part: Journal | undefined, added: Map<string, Set<string>>) {
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

export function entriesOf<T>(keys: Set<string>, now: Record<string, T>): Record<string, T | null> {
  const entries: Record<string, T | null> = {};
  for (const key of keys) entries[key] = key in now ? now[key]! : null;
  return entries;
}

export function replayChanges(scopes: SyncDoc["scopes"], changes: Record<string, ScopeChange>, live: Set<string>) {
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
