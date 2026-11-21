import { actDocument, actLease, actRelease, controlStatus, revokePluginCredential } from "../../platform/control";
import { useBrowser } from "../browser/store";
import type { Tab } from "../browser/types";

export type StepKind = "read" | "act";
export type ActLeaseEnd = "done" | "document" | "profile" | "tab" | "stopped" | "revoked";
export type ActLeaseCleanup = "released" | "revoked" | "unconfirmed";
export type ActLeaseSupport = "supported" | "unsupported" | "unknown";

export type ActLease = {
  readonly owner: string;
  readonly tab: string;
  readonly credential: string;
  readonly profile: string;
  readonly url: string;
  readonly navigation: number | null;
  engine: number | null;
  ended: ActLeaseEnd | null;
  cleanup: ActLeaseCleanup | null;
};

export type ActStep = { kind: StepKind; owner: string; tab: string; credential: string; expectedDocument: number | null };
export type ActLeaseGrant = { lease: ActLease } | { refused: string; cleanup?: ActLeaseCleanup };
export type ActLeaseOutcome<T> = { ok: true; value: T; cleanup: ActLeaseCleanup } | { ok: false; refused: string; cleanup?: ActLeaseCleanup };
export type ActFailure = Error & { cleanup: ActLeaseCleanup };

const leases = new Set<ActLease>();
const granting = new Map<ActLease, Promise<unknown>>();
const cleanups = new Map<ActLease, Promise<ActLeaseCleanup>>();
let support: Promise<ActLeaseSupport> | null = null;

const navigationOf = (tab: Tab | undefined) => (tab?.page as { nav?: { seq?: number } } | undefined)?.nav?.seq ?? null;

const UNREADABLE_REASON = "the step failed with an error that couldn't be read";

const reasonOf = (error: unknown): string => {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return UNREADABLE_REASON;
  }
};

export function actLeaseSupport(): Promise<ActLeaseSupport> {
  support ??= controlStatus().then(
    (status): ActLeaseSupport => (typeof status?.actLeases === "object" && status.actLeases !== null ? "supported" : "unsupported"),
    (): ActLeaseSupport => {
      support = null;
      return "unknown";
    },
  );
  return support;
}

export async function actDocumentOf(tab: string, credential: string): Promise<number | null> {
  if ((await actLeaseSupport()) !== "supported") return null;
  try {
    return (await actDocument(tab, credential)).document;
  } catch {
    return null;
  }
}

function settle(lease: ActLease, cleanup: ActLeaseCleanup) {
  lease.cleanup = cleanup;
  leases.delete(lease);
  cleanups.delete(lease);
}

function forgetCredential(credential: string) {
  for (const other of [...leases]) {
    if (other.credential !== credential) continue;
    other.ended ??= "revoked";
    other.engine = null;
    settle(other, "revoked");
  }
}

async function endInEngine(lease: ActLease): Promise<ActLeaseCleanup> {
  if (lease.engine === null) return "released";
  try {
    await actRelease(lease.engine);
    lease.engine = null;
    return "released";
  } catch {
    try {
      await revokePluginCredential(lease.credential);
    } catch {
      return "unconfirmed";
    }
    forgetCredential(lease.credential);
    return "revoked";
  }
}

export function releaseActLease(lease: ActLease, why: ActLeaseEnd = "done"): Promise<ActLeaseCleanup> {
  lease.ended ??= why;
  if (lease.cleanup) return Promise.resolve(lease.cleanup);
  const pending = granting.get(lease);
  if (pending) return pending.then(() => releaseActLease(lease, why));
  let cleanup = cleanups.get(lease);
  if (!cleanup) {
    cleanup = endInEngine(lease).then((result) => {
      if (lease.cleanup) return lease.cleanup;
      if (result === "unconfirmed") {
        cleanups.delete(lease);
      } else {
        settle(lease, result);
      }
      return result;
    });
    cleanups.set(lease, cleanup);
  }
  return cleanup;
}

export function endActLeasesOf(owner: string): Promise<ActLeaseCleanup[]> {
  return Promise.all([...leases].filter((lease) => lease.owner === owner).map((lease) => releaseActLease(lease, "stopped")));
}

export function liveActLeases(): readonly ActLease[] {
  return [...leases];
}

function changed(lease: ActLease, tab: Tab | undefined): ActLeaseEnd | null {
  if (!tab) return "tab";
  if (tab.profileId !== lease.profile) return "profile";
  if (tab.url !== lease.url || navigationOf(tab) !== lease.navigation) return "document";
  return null;
}

function endedText(why: ActLeaseEnd, tab: string): string {
  if (why === "tab") return `Tab ${tab} closed before the step ran, so nothing ran.`;
  if (why === "profile") return `Tab ${tab} moved to another profile before the step ran, so nothing ran.`;
  if (why === "stopped" || why === "revoked") return "The activity stopped before the step ran, so nothing ran.";
  return `Tab ${tab} loaded a new page before the step ran, so nothing ran.`;
}

function unsupportedText(found: ActLeaseSupport): string {
  return found === "unknown"
    ? "Ardia couldn't confirm that this engine holds plugins to approved acts, so nothing ran. Try the step again."
    : "This engine can't hold plugins to approved acts, so nothing ran. Update Ardia to let plugins act.";
}

async function askEngine(lease: ActLease, expectedDocument: number | null): Promise<string | null> {
  const found = await actLeaseSupport();
  if (found !== "supported") {
    lease.ended ??= "done";
    return unsupportedText(found);
  }
  if (expectedDocument === null) {
    lease.ended ??= "document";
    return `Tab ${lease.tab}'s page wasn't captured when the step was approved, so nothing ran.`;
  }
  try {
    lease.engine = (await actLease(lease.tab, lease.credential, expectedDocument)).lease;
    return null;
  } catch (error) {
    lease.ended ??= "done";
    return `Ardia couldn't hold tab ${lease.tab} for this step: ${reasonOf(error)}.`;
  }
}

export async function grantActLease(owner: string, tab: string, credential: string, expectedDocument: number | null): Promise<ActLeaseGrant> {
  const entry = useBrowser.getState().tabs[tab];
  if (!entry) return { refused: `Tab ${tab} is gone.` };
  const lease: ActLease = { owner, tab, credential, profile: entry.profileId, url: entry.url, navigation: navigationOf(entry), engine: null, ended: null, cleanup: null };
  leases.add(lease);
  const asked = askEngine(lease, expectedDocument);
  granting.set(lease, asked);
  const refusal = await asked;
  granting.delete(lease);
  if (refusal) {
    leases.delete(lease);
    return { refused: refusal };
  }
  const why = lease.ended ?? changed(lease, useBrowser.getState().tabs[tab]);
  if (why) {
    const cleanup = await releaseActLease(lease, why);
    return { refused: endedText(why, tab), cleanup };
  }
  return { lease };
}

export async function withActLease<T>(step: ActStep, run: (lease: ActLease | null) => Promise<T>): Promise<ActLeaseOutcome<T>> {
  if (step.kind === "read") return { ok: true, value: await run(null), cleanup: "released" };
  const granted = await grantActLease(step.owner, step.tab, step.credential, step.expectedDocument);
  if ("refused" in granted) return { ok: false, refused: granted.refused, ...(granted.cleanup ? { cleanup: granted.cleanup } : {}) };
  let value: T;
  try {
    value = await run(granted.lease);
  } catch (error) {
    const cleanup = await releaseActLease(granted.lease);
    throw Object.assign(new Error(reasonOf(error), { cause: error }), { cleanup }) satisfies ActFailure;
  }
  const cleanup = await releaseActLease(granted.lease);
  return { ok: true, value, cleanup };
}

let unsubscribe: (() => void) | null = null;

export function startActLeases() {
  if (unsubscribe) return;
  unsubscribe = useBrowser.subscribe((state, previous) => {
    if (state.tabs === previous.tabs || leases.size === 0) return;
    for (const lease of [...leases]) {
      if (lease.ended) continue;
      const why = changed(lease, state.tabs[lease.tab]);
      if (why) void releaseActLease(lease, why);
    }
  });
}

export async function stopActLeases(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  await Promise.all([...leases].map((lease) => releaseActLease(lease, "stopped")));
  support = null;
}
