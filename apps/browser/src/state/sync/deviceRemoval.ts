import type { Adapter, HLC, ScopeState } from "../../platform/sync";
import { isFields, isStringList } from "../../lib/decode";
import { DEVICE } from "./records";
import { deviceRecords } from "./devices";
import { APP_SCOPE, type SyncDoc } from "./syncDoc";

let removals = 0;
let returned = 0;

const keyOf = (id: string) => `${DEVICE}${id}`;

const liveTargets = (app: ScopeState | undefined, ids: string[]): [string, HLC][] =>
  ids.flatMap((id) => {
    const record = app?.records[keyOf(id)];
    return record && record.v !== null ? [[id, record.h]] : [];
  });

function removalTargets(doc: SyncDoc): Record<string, HLC> {
  const saved = doc.removingDevices;
  const entries = isStringList(saved)
    ? liveTargets(doc.scopes[APP_SCOPE], saved)
    : isFields(saved)
      ? Object.entries(saved).filter((entry): entry is [string, HLC] => typeof entry[1] === "string")
      : [];
  return Object.fromEntries(entries.filter(([id]) => id !== doc.deviceId));
}

export function freezeDeviceRemovals(doc: SyncDoc): boolean {
  if (!isStringList(doc.removingDevices) || !doc.scopes[APP_SCOPE]?.joined) return false;
  const targets = removalTargets(doc);
  if (Object.keys(targets).length) doc.removingDevices = targets;
  else delete doc.removingDevices;
  return true;
}

const stillTargeted = (app: ScopeState | undefined, key: string, h: HLC) => app?.records[key]?.h === h;

export const removedDeviceKeys = (doc: SyncDoc): ReadonlySet<string> =>
  new Set(Object.entries(removalTargets(doc)).filter(([id, h]) => stillTargeted(doc.scopes[APP_SCOPE], keyOf(id), h)).map(([id]) => keyOf(id)));

export const deviceBeingRemoved = (doc: SyncDoc, id: string) => id in removalTargets(doc);

export function markDeviceRemoved(doc: SyncDoc, id: string): boolean {
  const app = doc.scopes[APP_SCOPE];
  const record = app?.records[keyOf(id)];
  if (!app || !record || id === doc.deviceId || !deviceRecords(app).has(id) || deviceBeingRemoved(doc, id)) return false;
  doc.removingDevices = { ...removalTargets(doc), [id]: record.h };
  removals++;
  return true;
}

export function settleDeviceRemovals(doc: SyncDoc, app: ScopeState) {
  const left = Object.entries(removalTargets(doc)).filter(([id, h]) => {
    const record = app.records[keyOf(id)];
    if (record?.h === h) return true;
    if (record && record.v !== null) returned++;
    return false;
  });
  if (left.length) doc.removingDevices = Object.fromEntries(left);
  else delete doc.removingDevices;
}

export function alsoDeleting(adapter: Adapter, gone: () => ReadonlySet<string>): Adapter {
  return {
    ...adapter,
    extract: (...args) =>
      Promise.resolve(adapter.extract(...args)).then((found) => found && { ...found, ignore: (key: string) => !gone().has(key) && !!found.ignore?.(key) }),
  };
}

export function takeSyncedDeviceRemovals() {
  const taken = removals;
  removals = 0;
  return taken;
}

export function takeReturnedDeviceRemovals() {
  const taken = returned;
  returned = 0;
  return taken;
}
