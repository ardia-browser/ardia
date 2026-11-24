import "../../platform/copy";
import type { ImportOutcome } from "../legacy/importer";
import { importOldApp, startWithoutOldApp } from "../legacy/upgrade";
import { keepWaitingLinks, listenForLinks } from "../links/links";
import { readPreferences, writePreference } from "../store/browserDatabase";
import { browserDatabase, browserDatabaseIsDurable, relaxBrowserDatabase } from "../store/database";
import { nativeImportState, type NativeImportState } from "../../platform/legacy";
import { useBoot } from "./bootState";
import { launchArguments } from "./launchFlags";

export { useBoot };

let begin: (() => void) | null = null;

const SETTLED_IMPORT_KEY = "legacy.settled";
const COMPLETED_OUTCOMES: readonly ImportOutcome[] = ["imported", "startedFresh"];

type CompletedLookup = { readable: true; outcome: ImportOutcome | null } | { readable: false };

function completedImportBefore(): CompletedLookup {
  try {
    if (!browserDatabaseIsDurable()) return { readable: true, outcome: null };
    const stored = readPreferences(browserDatabase())[SETTLED_IMPORT_KEY];
    return { readable: true, outcome: COMPLETED_OUTCOMES.find((outcome) => outcome === stored) ?? null };
  } catch {
    return { readable: false };
  }
}

function rememberImportSettled(outcome: ImportOutcome) {
  try {
    if (!browserDatabaseIsDurable()) return;
    if (COMPLETED_OUTCOMES.includes(outcome)) writePreference(browserDatabase(), SETTLED_IMPORT_KEY, outcome);
    relaxBrowserDatabase();
  } catch {
    return;
  }
}

export function settledWithoutWaiting(native: NativeImportState, completed: ImportOutcome | null): ImportOutcome | null {
  if (native === "none" || native === "imported") return native;
  if (native === "startedFresh") return completed === "startedFresh" ? "startedFresh" : null;
  if (native === "unknown") return completed;
  return null;
}

export function bootApp(start: () => void) {
  if (begin) return;
  begin = start;
  listenForLinks();
  if (launchArguments().isDemo) {
    finish("none");
    return;
  }
  const completed = completedImportBefore();
  const settled = completed.readable ? settledWithoutWaiting(nativeImportState(), completed.outcome) : null;
  if (settled) finish(settled);
  else void attempt();
}

async function attempt() {
  useBoot.setState({ busy: true });
  const result = await importOldApp();
  if (result.kind === "ready") finish(result.outcome);
  else {
    useBoot.setState((state) => ({ failures: state.failures + 1, busy: false }));
    keepWaitingLinks();
  }
}

function finish(outcome: ImportOutcome) {
  if (useBoot.getState().ready || !begin) return;
  begin();
  useBoot.setState({ ready: true, busy: false, outcome });
  if (!launchArguments().isDemo) rememberImportSettled(outcome);
}

export function retryImport() {
  const state = useBoot.getState();
  if (state.ready || state.busy || !begin) return;
  void attempt();
}

export async function startWithoutImporting() {
  const state = useBoot.getState();
  if (state.ready || state.busy || !begin) return;
  useBoot.setState({ busy: true });
  if (await startWithoutOldApp()) finish("startedFresh");
  else useBoot.setState((s) => ({ failures: s.failures + 1, busy: false }));
}
