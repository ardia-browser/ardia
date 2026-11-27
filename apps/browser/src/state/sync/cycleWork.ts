import { consentToken, onConsentPeriodChange, stillValid, type ConsentToken } from "../telemetry/choice";
import { beginActivity } from "../app/jobActivity";
import { takeFolderCounts } from "./folderMove";
import { takeReturnedDeviceRemovals, takeReturnedProfileRemovals, takeSyncedDeviceRemovals, takeSyncedProfileRemovals } from "./profileRemoval";

const NO_CYCLES = { cycles: 0, ms: 0, longestMs: 0 };
let work = NO_CYCLES;
let reapplied = 0;
let chainGoneFor: string | null = null;
let chainCounts = { missing: 0, returned: 0 };

onConsentPeriodChange(() => ((work = NO_CYCLES), (reapplied = 0), (chainGoneFor = null), (chainCounts = { missing: 0, returned: 0 })));

export function noteChainStatus(token: ConsentToken | null, device: string, status: "ok" | "missing") {
  if (token === null || !stillValid(token)) return status;
  const returned = chainGoneFor === device && status === "ok";
  const gone = chainGoneFor !== device && status === "missing";
  chainGoneFor = status === "missing" ? device : null;
  if (gone) chainCounts.missing++;
  if (returned) chainCounts.returned++;
  return status;
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

export function takeSnapshotWrites() {
  const taken = { ...snapshotWrites, reapplied, ...takeCycleWork(), removedProfiles: takeSyncedProfileRemovals(), removedDevices: takeSyncedDeviceRemovals(), removalsReturned: takeReturnedProfileRemovals() + takeReturnedDeviceRemovals(), folders: takeFolderCounts(), chainMissing: chainCounts.missing, chainReturned: chainCounts.returned };
  snapshotWrites = { count: 0, bytes: 0 };
  reapplied = 0;
  chainCounts = { missing: 0, returned: 0 };
  return taken;
}
