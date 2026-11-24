import type { SqlDatabase } from "../../lib/sqlDatabase.ts";
import {
  asyncTransaction,
  bringOpenTabToFront,
  countArchivedTabs,
  countTabStates,
  countVisits,
  existingTabIds,
  insertNewTab,
  insertVisit,
  maxVisitId,
  readOpenTabs,
  readPreferences,
  writePreference,
  writeTabState,
} from "../store/browserDatabase.ts";
import {
  countReason,
  exclusionCounts,
  importPreferences,
  isLegacyCounts,
  isLegacyRead,
  isVisitPage,
  LEGACY_FRESH_KEY,
  LEGACY_FRESH_VERSION,
  LEGACY_RECEIPT_KEY,
  OLD_IMPORT_KEY,
  OLD_IMPORTED,
  planTabs,
  planVisit,
  readReceipt,
  RECEIPT_VERSION,
  samePreference,
  unusableReason,
  type ImportPlatform,
  type LegacyCounts,
  type LegacyReceipt,
  type LegacySourceInput,
  type LegacyUnusableReason,
  type Tally,
} from "./importRules.ts";

export const VISIT_PAGE = 5_000;

export type LegacyApi = {
  source(): Promise<LegacySourceInput>;
  read(): Promise<unknown>;
  readVisits(afterId: number, limit: number): Promise<unknown>;
  applyNativeSettings(): Promise<void>;
  markImported(receipt: LegacyReceipt): Promise<void>;
  startFresh?(): Promise<void>;
};

export type ImportFailure =
  | "source"
  | `unusable_${LegacyUnusableReason}`
  | "memory"
  | "read"
  | "shape"
  | "readVisits"
  | "mismatch"
  | "write"
  | "applyNativeSettings"
  | "markImported"
  | "startFresh";

export type ImportOutcome = "none" | "imported" | "startedFresh";

export type ImportResult = { kind: "ready"; outcome: ImportOutcome } | { kind: "failed"; reason: ImportFailure };

export type ImportDeps = { legacy: LegacyApi; db: SqlDatabase; durable: boolean; platform: ImportPlatform; log: (line: string) => void };

class Stop extends Error {
  readonly reason: ImportFailure;
  constructor(reason: ImportFailure) {
    super(reason);
    this.reason = reason;
  }
}

async function step<T>(reason: ImportFailure, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof Stop ? error : new Stop(reason);
  }
}

export async function runLegacyImport(deps: ImportDeps): Promise<ImportResult> {
  try {
    return { kind: "ready", outcome: await importSteps(deps) };
  } catch (error) {
    const reason: ImportFailure = error instanceof Stop ? error.reason : "write";
    deps.log(`ardia-legacy failed reason=${reason}`);
    return { kind: "failed", reason };
  }
}

async function importSteps(deps: ImportDeps): Promise<ImportOutcome> {
  const stored = deps.durable ? readPreferences(deps.db) : {};
  const choseFresh = stored[LEGACY_FRESH_KEY] === LEGACY_FRESH_VERSION;
  const freshOr = async (error: unknown): Promise<ImportOutcome> => {
    if (!choseFresh) throw error;
    await openWithoutImport(deps);
    return "startedFresh";
  };
  let source: LegacySourceInput;
  try {
    source = await step("source", () => deps.legacy.source());
  } catch (error) {
    return freshOr(error);
  }
  if (source?.kind === "none") return "none";
  const nativeChoseFresh = source?.kind === "done" && source.outcome === "startedFresh";
  if (source?.kind === "done" && !nativeChoseFresh) return "imported";
  if (source?.kind !== "pending" && source?.kind !== "unusable" && !nativeChoseFresh) throw new Stop("shape");
  if (!deps.durable) {
    if (nativeChoseFresh) return "startedFresh";
    throw new Stop("memory");
  }
  const receipt = readReceipt(stored[LEGACY_RECEIPT_KEY]) ?? oldImporterReceipt(deps.db, stored);
  if (receipt) {
    try {
      await finishNative(deps, receipt);
      return "imported";
    } catch (error) {
      if (nativeChoseFresh) return "startedFresh";
      return freshOr(error);
    }
  }
  if (nativeChoseFresh) return "startedFresh";
  if (choseFresh) return freshOr(null);
  if (source.kind === "unusable") throw new Stop(`unusable_${unusableReason(source.reason)}`);
  if (source.kind !== "pending" || !isLegacyCounts(source.counts)) throw new Stop("shape");
  await finishNative(deps, await importInto(deps, source.counts));
  return "imported";
}

function oldImporterReceipt(db: SqlDatabase, stored: Record<string, string>): LegacyReceipt | null {
  if (stored[OLD_IMPORT_KEY] !== OLD_IMPORTED) return null;
  return { version: RECEIPT_VERSION, tabs: readOpenTabs(db).length, archive: countArchivedTabs(db), visits: countVisits(db), preferences: 0 };
}

async function finishNative(deps: ImportDeps, receipt: LegacyReceipt) {
  await step("applyNativeSettings", () => deps.legacy.applyNativeSettings());
  await step("markImported", () => deps.legacy.markImported(receipt));
}

async function openWithoutImport(deps: ImportDeps) {
  const open = deps.legacy.startFresh;
  if (!open) throw new Stop("startFresh");
  await step("startFresh", () => open());
}

async function importInto(deps: ImportDeps, counts: LegacyCounts): Promise<LegacyReceipt> {
  const { db } = deps;
  const read = await step("read", () => deps.legacy.read());
  if (!isLegacyRead(read)) throw new Stop("shape");
  if (read.tabs.length !== counts.tabs || read.archive.length !== counts.archive) throw new Stop("mismatch");
  const plan = planTabs(read, deps.platform);
  const preferences = importPreferences(read.preferences);
  const excluded: Record<string, Tally> = { tabs: plan.excluded.tabs, archive: plan.excluded.archive, visits: {}, preferences: preferences.excluded };
  let receipt: LegacyReceipt | null = null;
  let states = 0;
  await step("write", () =>
    asyncTransaction(db, async () => {
      const present = existingTabIds(db, plan.tabs.map((tab) => tab.id));
      const added = plan.tabs.filter((tab) => {
        if (!present.has(tab.id)) return true;
        countReason(tab.archivedAt === null ? excluded.tabs! : excluded.archive!, "present");
        return false;
      });
      for (const tab of added) insertNewTab(db, tab);
      if (plan.selectedId) bringOpenTabToFront(db, plan.selectedId);
      const withState = added.filter((tab) => plan.states.has(tab.id));
      for (const tab of withState) writeTabState(db, tab.id, plan.states.get(tab.id)!);
      states = withState.length;

      const before = readPreferences(db);
      const written = Object.entries(preferences.values).filter(([key]) => {
        if (before[key] === undefined) return true;
        countReason(excluded.preferences!, "present");
        return false;
      });
      for (const [key, value] of written) writePreference(db, key, value);

      const visitsBefore = countVisits(db);
      let nextId = maxVisitId(db);
      let after = 0;
      let seen = 0;
      let visitsAdded = 0;
      for (;;) {
        const page = await step("readVisits", () => deps.legacy.readVisits(after, VISIT_PAGE));
        if (!db.inTransaction()) throw new Stop("write");
        if (!isVisitPage(page) || page.visits.length > VISIT_PAGE) throw new Stop("shape");
        for (const raw of page.visits) {
          seen += 1;
          const visit = planVisit(raw);
          if (typeof visit === "string") {
            countReason(excluded.visits!, visit);
            continue;
          }
          nextId += 1;
          insertVisit(db, { id: nextId, ...visit });
          visitsAdded += 1;
        }
        if (page.next === null || page.next === undefined) break;
        if (!(page.next > after) || page.visits.length === 0) throw new Stop("shape");
        after = page.next;
      }
      if (seen !== counts.visits) throw new Stop("mismatch");

      const addedIds = added.map((tab) => tab.id);
      const landed = readPreferences(db);
      if (
        existingTabIds(db, addedIds).size !== added.length ||
        countTabStates(db, withState.map((tab) => tab.id)) !== withState.length ||
        countVisits(db) !== visitsBefore + visitsAdded ||
        !written.every(([key, value]) => samePreference(key, landed[key], value))
      ) {
        throw new Stop("mismatch");
      }
      const open = added.filter((tab) => tab.archivedAt === null).length;
      receipt = { version: RECEIPT_VERSION, tabs: open, archive: added.length - open, visits: visitsAdded, preferences: written.length };
      writePreference(db, LEGACY_RECEIPT_KEY, JSON.stringify(receipt));
    }),
  );
  const done = receipt as LegacyReceipt | null;
  if (!done) throw new Stop("write");
  deps.log(
    `ardia-legacy imported tabs=${done.tabs} archive=${done.archive} states=${states} visits=${done.visits} preferences=${done.preferences} ${exclusionCounts(excluded)}`.trim(),
  );
  return done;
}

export async function startWithoutImport(deps: ImportDeps): Promise<boolean> {
  if (!deps.durable || !deps.legacy.startFresh) return false;
  try {
    await deps.legacy.startFresh();
    writePreference(deps.db, LEGACY_FRESH_KEY, LEGACY_FRESH_VERSION);
  } catch {
    deps.log("ardia-legacy start-fresh failed");
    return false;
  }
  deps.log("ardia-legacy started fresh");
  return true;
}
