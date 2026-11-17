import type { Adapter, ScopeState } from "../../platform/sync";
import { isStringList } from "../../lib/decode";
import { DEVICE } from "./records";
import { deviceRecords } from "./devices";
import { APP_SCOPE, type SyncDoc } from "./syncDoc";

let removals = 0;

const removingDeviceIds = (doc: SyncDoc) => (isStringList(doc.removingDevices) ? doc.removingDevices.filter((id) => id !== doc.deviceId) : []);

export const removedDeviceKeys = (doc: SyncDoc): ReadonlySet<string> => new Set(removingDeviceIds(doc).map((id) => `${DEVICE}${id}`));

export const deviceBeingRemoved = (doc: SyncDoc, id: string) => removingDeviceIds(doc).includes(id);

export function markDeviceRemoved(doc: SyncDoc, id: string): boolean {
  const app = doc.scopes[APP_SCOPE];
  if (!app || id === doc.deviceId || !deviceRecords(app).has(id) || deviceBeingRemoved(doc, id)) return false;
  doc.removingDevices = [...removingDeviceIds(doc), id];
  removals++;
  return true;
}

export function settleDeviceRemovals(doc: SyncDoc, app: ScopeState) {
  const unapplied = new Set(app.unapplied);
  const left = removingDeviceIds(doc).filter((id) => `${DEVICE}${id}` in app.base || unapplied.has(`${DEVICE}${id}`));
  if (left.length) doc.removingDevices = left;
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
