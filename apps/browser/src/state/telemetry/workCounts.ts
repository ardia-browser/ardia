import type { Adapter } from "../../platform/sync";
import { consentToken, isSharing, stillValid, onConsentPeriodChange, type ConsentToken } from "./choice";
import { countFor, fieldName } from "./countFor";
import { takePopupProtectedMediaCounts } from "./popupProtectedMedia";

export type SyncWorkKind = "bookmark" | "history";
type Phase = "extract" | "apply";

const phase = () => ({ runs: 0, msTotal: 0, msMax: 0 });
const work = () => ({ extract: phase(), apply: phase(), recordsMax: 0 });
const noSync = () => ({ bookmark: work(), history: work() });

let syncPending = noSync();

function noteSyncWork(kind: SyncWorkKind, step: Phase, records: number, ms: number) {
  if (!isSharing()) return;
  const counted = syncPending[kind];
  const runs = counted[step];
  runs.runs++;
  runs.msTotal += ms;
  runs.msMax = Math.max(runs.msMax, ms);
  counted.recordsMax = Math.max(counted.recordsMax, records);
}

function timed<T>(run: () => T, done: (result: Awaited<T>, ms: number) => void): T {
  const token = consentToken();
  if (token === null) return run();
  const started = performance.now();
  const finish = (value: Awaited<T>) => { if (stillValid(token)) done(value, performance.now() - started); };
  const result = run();
  if (result instanceof Promise) return result.then((value: Awaited<T>) => (finish(value), value)) as T;
  finish(result as Awaited<T>);
  return result;
}

export function withSyncWorkCounts(kind: SyncWorkKind, adapter: Adapter): Adapter {
  return {
    ...adapter,
    extract: (...args) => timed(() => adapter.extract(...args), (extracted, ms) => extracted && noteSyncWork(kind, "extract", extracted.values.size, ms)),
    apply: (...args) => timed(() => adapter.apply(...args), (_applied, ms) => noteSyncWork(kind, "apply", args[0].size, ms)),
  };
}

export function takeSyncWorkCounts(): Record<string, number> {
  const taken = syncPending;
  syncPending = noSync();
  const fields = (kind: SyncWorkKind) => {
    const { extract, apply, recordsMax } = taken[kind];
    return {
      [`sync_${kind}_extracts`]: extract.runs,
      [`sync_${kind}_extract_ms_total`]: Math.round(extract.msTotal),
      [`sync_${kind}_extract_ms_max`]: Math.round(extract.msMax),
      [`sync_${kind}_applies`]: apply.runs,
      [`sync_${kind}_apply_ms_total`]: Math.round(apply.msTotal),
      [`sync_${kind}_apply_ms_max`]: Math.round(apply.msMax),
      [`sync_${kind}_records_max`]: recordsMax,
    };
  };
  return { ...fields("bookmark"), ...fields("history") };
}

const none = () => ({
  liveSourceFetches: 0,
  liveSourceFetchesShared: 0,
  liveSavesWritten: 0,
  liveSavesUnchanged: 0,
  liveSaveIntentsQueued: 0,
  liveSaveIntentsUnchanged: 0,
  extensionActionRefreshes: 0,
  extensionActionStateRequests: 0,
  extensionActionStateFailures: 0,
  extensionActionTabChangesSkipped: 0,
});

let pending = none();

onConsentPeriodChange(() => {
  syncPending = noSync();
  pending = none();
});

const count = (key: keyof ReturnType<typeof none>, consent?: ConsentToken | null) =>
  countFor(consent, () => void (isSharing() && pending[key]++), { [fieldName(key)]: 1 });

export const noteLiveSourceFetch = (shared: boolean) => count(shared ? "liveSourceFetchesShared" : "liveSourceFetches");
export const noteLiveSave = (changed: boolean, kind: "write" | "intent" = "write") =>
  count(kind === "intent" ? changed ? "liveSaveIntentsQueued" : "liveSaveIntentsUnchanged" : changed ? "liveSavesWritten" : "liveSavesUnchanged");
export const noteExtensionActionRefresh = () => count("extensionActionRefreshes");
export const noteExtensionActionStateRequest = () => count("extensionActionStateRequests");
export const noteExtensionActionStateFailure = (consent?: ConsentToken | null) => count("extensionActionStateFailures", consent);
export const noteExtensionActionTabChangeSkipped = () => count("extensionActionTabChangesSkipped");

export function takeLiveWorkCounts() {
  const taken = pending;
  pending = none();
  return {
    live_source_fetches: taken.liveSourceFetches,
    live_source_fetches_shared: taken.liveSourceFetchesShared,
    live_saves_written: taken.liveSavesWritten,
    live_saves_unchanged: taken.liveSavesUnchanged,
    live_save_intents_queued: taken.liveSaveIntentsQueued,
    live_save_intents_unchanged: taken.liveSaveIntentsUnchanged,
    extension_action_refreshes: taken.extensionActionRefreshes,
    extension_action_state_requests: taken.extensionActionStateRequests,
    extension_action_state_failures: taken.extensionActionStateFailures,
    extension_action_tab_changes_skipped: taken.extensionActionTabChangesSkipped,
  };
}

export const takeWorkCounts = () => ({ ...takeSyncWorkCounts(), ...takeLiveWorkCounts(), ...takePopupProtectedMediaCounts() });
