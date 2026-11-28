import { ardiaError } from "@ardia/core";
import { orWarn } from "../../lib/fallback";
import { applySafari, emptyCounts, importBookmarks, untitledLinks, type ImportKind, type SafariExport } from "./apply";
import { choosing, finishImport, importNow, importSignal, inRun, NO_EXTENSIONS, patchImport, startProgress, updateStatus } from "./flow";
import { importModule } from "./importApi";
import { claimRead, claimSettle, ownsTurn, releaseRead, whileOwned, type ImportTurn } from "./importTurn";
import { settleSource, turnFor } from "./runImport";
import { consentToken } from "../telemetry/client";
import { noteUntitledBookmarks } from "../telemetry/importRuns";

export const openFullDiskAccessSettings = () => void importModule().openFullDiskAccessSettings();

export async function pickSafariExport(token: number | null) {
  const turn = turnFor(token, "safari");
  if (!turn) return;
  await whileOwned(turn, importModule().chooseImportFile("safariExport"), (path) => (path && importNow().step.name === "safari" ? readSafari(turn, "export", path) : undefined)).catch(
    orWarn(undefined),
  );
}

export function importSafariExport(path: string, token: number | null) {
  const turn = turnFor(token, "safari");
  return turn ? readSafari(turn, "export", path) : Promise.resolve();
}

export function importSafariDirect(token: number | null) {
  const turn = turnFor(token, "safari");
  return turn ? readSafari(turn, "direct", "") : Promise.resolve();
}

const EXPORT_STATUS = { bookmarks: "active", history: "active", passwords: "active", autofill: "active" } as const;

async function readSafari(turn: ImportTurn, how: "export" | "direct", path: string) {
  if (!claimRead(turn)) return;
  const { target, safariCookies } = importNow();
  const cookies = how === "direct" && safariCookies;
  const multi = inRun(importNow());
  const api = importModule();
  startProgress(how === "export" ? EXPORT_STATUS : { bookmarks: "active", history: "active", tabs: "active", ...(cookies ? { cookies: "active" as const } : {}) }, 1);
  try {
    await whileOwned(
      turn,
      how === "export" ? api.importSafariExport(path, { signal: turn.signal }) : api.importSafariDirect({ signal: turn.signal }),
      (data) => applySafariRead(turn, data, { how, target, cookies, multi }),
      discardVault,
    );
  } catch (e) {
    const { code } = ardiaError(e);
    if (!ownsTurn(turn)) return;
    releaseRead(turn);
    if (how === "direct" && code === "cancelled") return;
    const error =
      how === "export"
        ? code === "unsupported"
          ? "Please select a folder or zip file."
          : "The selected file is invalid. Please try again."
        : code === "locked"
          ? "Ardia still doesn't have Full Disk Access. Grant it above, or use the export file below."
          : "Couldn't read Safari's data. Try the export file below.";
    patchImport({ step: { name: "safari", error }, ...(how === "direct" ? { fullDiskAccess: api.safariHasFullDiskAccess() } : {}) });
  }
}

const discardVault = (data: { vaultToken?: string } | null | undefined) => {
  if (data?.vaultToken) importModule().discardImported(data.vaultToken);
};

type SafariApply = { how: "export" | "direct"; target: string; cookies: boolean; multi: boolean };

async function applySafariRead(turn: ImportTurn, data: SafariExport, { how, target, cookies, multi }: SafariApply) {
  const { consent, signal } = turn;
  const failed: ImportKind[] = [];
  const counts = await applySafari(target, multi ? { ...data, credentials: [] } : data, cookies, (k) => failed.push(k), consent, signal);
  if (signal.aborted) return;
  noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
  const state = (k: ImportKind) => (failed.includes(k) ? "failed" : "done");
  updateStatus(signal, () =>
    how === "export"
      ? { bookmarks: "done", history: state("history"), passwords: "done", autofill: state("autofill") }
      : { bookmarks: "done", history: state("history"), tabs: "done", ...(cookies ? { cookies: state("cookies") } : {}) },
  );
  const failures = failed.map((kind) => ({ kind, profiles: [] }));
  const { source } = importNow();
  if (!multi || !source) {
    if (claimSettle(turn)) finishImport(signal, { counts, failures, notes: [], extensions: NO_EXTENSIONS });
    return;
  }
  const outcome = { source: { id: source.id, name: source.name, family: source.family }, counts, failures, notes: [], extensions: { profileId: "", found: [], groups: [] }, engines: [], skipped: false, consent, passwordsWritten: { keptExisting: 0, failed: 0 } };
  await settleSource(turn, outcome, data.credentials.length ? [{ profileId: target, credentials: data.credentials }] : []);
}

export async function importBookmarksHtml() {
  if (!choosing()) return;
  const api = importModule();
  const signal = importSignal();
  const consent = consentToken();
  const path = await api.chooseImportFile("bookmarksHTML");
  if (!path || signal.aborted || !choosing()) return;
  try {
    const root = await api.importBookmarksHTML(path);
    if (signal.aborted || !choosing()) return;
    const failed: ImportKind[] = [];
    const bookmarks = await importBookmarks(importNow().target, root, "HTML File", consent, (kind) => failed.push(kind), signal);
    if (signal.aborted) return;
    noteUntitledBookmarks(untitledLinks(root), consent);
    if (!choosing()) return;
    const failures = failed.map((kind) => ({ kind, profiles: [] }));
    patchImport({ source: null, picked: [], step: { name: "done", counts: { ...emptyCounts(), bookmarks }, failures, notes: [], extensions: NO_EXTENSIONS } });
  } catch {
    if (!signal.aborted && choosing()) patchImport({ step: { name: "choose", error: "The selected file is invalid. Please try again." } });
  }
}
