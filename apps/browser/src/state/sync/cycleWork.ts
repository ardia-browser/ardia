import { consentToken, onConsentPeriodChange, stillValid, type ConsentToken } from "../telemetry/choice";
import { beginActivity } from "../app/jobActivity";
import { takeFolderCounts } from "./folderMove";
import type { ChainOutage } from "./syncDoc";
import { takeReturnedDeviceRemovals, takeReturnedProfileRemovals, takeSyncedDeviceRemovals, takeSyncedProfileRemovals } from "./profileRemoval";

const NO_CYCLES = { cycles: 0, ms: 0, longestMs: 0 };
let work = NO_CYCLES;
let reapplied = 0;
let folderUnavailable = 0;
let folderRecreated = 0;
let folderRecreateFailed = 0;
let chainCounts = { missing: 0, returned: 0 };

onConsentPeriodChange(() => ((work = NO_CYCLES), (reapplied = 0), (chainCounts = { missing: 0, returned: 0 }), (folderUnavailable = 0), (folderRecreated = 0), (folderRecreateFailed = 0)));

type OutageHolder = { chainOutage?: ChainOutage };

export function noteChainMissing(holder: OutageHolder, folder: string, consent: ConsentToken | null, verdict = true) {
  const outage = holder.chainOutage?.folder === folder ? holder.chainOutage : (holder.chainOutage = { folder, seen: consent, counted: false });
  if (!verdict || outage.counted || !stillValid(outage.seen as ConsentToken | null)) return;
  outage.counted = true;
  chainCounts.missing++;
}

export function noteChainHealthy(holder: OutageHolder, folder: string) {
  const outage = holder.chainOutage;
  if (!outage) return;
  delete holder.chainOutage;
  if (outage.folder === folder && outage.counted && stillValid(outage.seen as ConsentToken | null)) chainCounts.returned++;
}

export function timedCycle(startedAt: number, cycle: Promise<void>): Promise<void> {
  const done = beginActivity("sync", startedAt);
  void cycle.then(done, done);
  const token = consentToken();
  if (token === null) return cycle;
  return cycle.finally(() => {
    if (!stillValid(token)) return;
    const ms = Date.now() - startedAt;
    work = { cycles: work.cycles + 1, ms: work.ms + ms, longestMs: Math.max(work.longestMs, ms) };
  });
}

export function takeCycleWork() {
  const taken = work;
  work = NO_CYCLES;
  return taken;
}

let snapshotWrites = { count: 0, bytes: 0 };

export function noteSnapshot({ snapshotBytes }: { snapshotBytes: number }) {
  if (snapshotBytes) snapshotWrites = { count: snapshotWrites.count + 1, bytes: snapshotWrites.bytes + snapshotBytes };
}

export function noteReapplied(count: number, token: ConsentToken | null) {
  if (count > 0 && token !== null && stillValid(token)) reapplied += count;
}

export function noteCycle(token: ConsentToken | null, result: { snapshotBytes: number; reapplied: number }) {
  if (token === null || !stillValid(token)) return;
  noteSnapshot(result);
  noteReapplied(result.reapplied, token);
}

export function noteFolderUnavailable(token: ConsentToken | null) {
  if (token !== null && stillValid(token)) folderUnavailable++;
}

export function noteFolderRecreate(outcome: "recreated" | "failed", token: ConsentToken | null) {
  if (token === null || !stillValid(token)) return;
  if (outcome === "recreated") folderRecreated++;
  else folderRecreateFailed++;
}

export function takeSnapshotWrites() {
  const taken = {
    ...snapshotWrites,
    reapplied,
    ...takeCycleWork(),
    removedProfiles: takeSyncedProfileRemovals(),
    removedDevices: takeSyncedDeviceRemovals(),
    removalsReturned: takeReturnedProfileRemovals() + takeReturnedDeviceRemovals(),
    folders: takeFolderCounts(),
    folderUnavailable,
    folderRecreated,
    folderRecreateFailed,
    chainMissing: chainCounts.missing,
    chainReturned: chainCounts.returned,
  };
  snapshotWrites = { count: 0, bytes: 0 };
  reapplied = 0;
  folderUnavailable = 0;
  folderRecreated = 0;
  folderRecreateFailed = 0;
  chainCounts = { missing: 0, returned: 0 };
  return taken;
}
