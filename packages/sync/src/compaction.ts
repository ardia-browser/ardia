import { covered } from "./applied.ts";
import type { ScopeOptions, ScopeState, Transport } from "./scopeState.ts";

export const DEFAULTS: Required<Omit<ScopeOptions, "persist" | "holdApply" | "persistApplying" | "launch" | "nativeSaveMs" | "monotonic">> = {
  expired: () => false,
  tombstoneTTL: 45 * 86_400_000,
  compactAfterFiles: 40,
  compactAfterLogs: 400,
  compactLogShare: 0.25,
  compactInterval: 10 * 60_000,
  pruneGrace: 60 * 60_000,
  damagedGiveUp: 86_400_000,
};

type FileEntry = [string, ScopeState["files"][string]];

const dominates = (vv: Record<string, number>, other: Record<string, number>) => Object.entries(other).every(([d, s]) => (vv[d] ?? 0) >= s);

export function newestSnapshot(entries: FileEntry[], device?: string) {
  let newest: FileEntry | undefined;
  for (const entry of entries) if (entry[1].k === "snapshot" && (!device || entry[1].d === device) && (!newest || entry[1].at > newest[1].at)) newest = entry;
  return newest;
}

export function retiredBy(entries: FileEntry[], snapshotId: string, vv: Record<string, number>, now: number, pruneGrace: number, kinds: "logs" | "logsAndSnapshots") {
  return entries
    .filter(([fileId, f]) => {
      if (fileId === snapshotId || now - f.at < pruneGrace) return false;
      if (f.k === "log") return covered(vv, [f.d, f.s ?? Infinity]);
      if (f.k === "snapshot") return kinds === "logsAndSnapshots" && dominates(vv, f.vv ?? {});
      return false;
    })
    .map(([fileId]) => fileId);
}

export async function prune(state: ScopeState, transport: Transport, scope: string, ids: string[]) {
  if (!ids.length) return;
  await transport.remove(scope, ids);
  for (const fileId of ids) delete state.files[fileId];
}

export function compactionDue(state: ScopeState, now: number, options: ScopeOptions = {}) {
  const o = { ...DEFAULTS, ...options };
  const entries = Object.entries(state.files);
  const latest = newestSnapshot(entries);
  if (now - Math.max(state.snapshotAt, latest?.[1].at ?? 0) < o.compactInterval) return false;
  const base = latest?.[1].vv ?? {};
  let logs = 0;
  let logBytes = 0;
  for (const [, f] of entries) {
    if (f.k !== "log" || covered(base, [f.d, f.s ?? Infinity]) || !covered(state.vv, [f.d, f.s ?? Infinity])) continue;
    logs++;
    logBytes += f.b ?? 0;
  }
  if (logs <= o.compactAfterFiles) return false;
  return logs >= o.compactAfterLogs || logBytes >= o.compactLogShare * (latest?.[1].b ?? 0);
}

