import { ardiaError } from "@ardia/core";
import { applySafari, emptyCounts, importBookmarks, importDestination, IMPORT_DESTINATION_CHANGED, untitledLinks, type ImportKind } from "./apply";
import { finishImport, importNow, importSignal, NO_EXTENSIONS, patchImport, startProgress, updateStatus } from "./flow";
import { importModule } from "./importApi";
import { consentToken } from "../telemetry/client";
import { noteUntitledBookmarks } from "../telemetry/importRuns";

export const chooseSafariExport = () => importModule().chooseImportFile("safariExport");
export const openFullDiskAccessSettings = () => void importModule().openFullDiskAccessSettings();


function selectedDestination(target: string) {
  const destination = importDestination(target);
  return destination && { ...destination, current: () => importNow().target === target && destination.current() };
}

export async function importSafariExport(path: string) {
  const consent = consentToken();
  const { target } = importNow();
  const destination = selectedDestination(target);
  const signal = importSignal();
  startProgress({ bookmarks: "active", history: "active", passwords: "active", autofill: "active" }, 1);
  try {
    const data = await importModule().importSafariExport(path);
    const failed: ImportKind[] = [];
    const counts = await applySafari(target, data, false, (k) => failed.push(k), destination, consent);
    updateStatus(signal, () => ({ bookmarks: "done", history: "done", passwords: "done", autofill: failed.includes("autofill") ? "failed" : "done" }));
    finishImport(signal, { counts, failures: [...new Set(failed)].map((kind) => ({ kind, profiles: [] })), notes: destination?.current() ? [] : [IMPORT_DESTINATION_CHANGED], extensions: NO_EXTENSIONS });
    noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
  } catch (e) {
    if (signal.aborted) return;
    patchImport({ step: { name: "safari", error: ardiaError(e).code === "unsupported" ? "Please select a folder or zip file." : "The selected file is invalid. Please try again." } });
  }
}

export async function importSafariDirect() {
  const consent = consentToken();
  const { target, safariCookies } = importNow();
  const destination = selectedDestination(target);
  const signal = importSignal();
  const api = importModule();
  startProgress({ bookmarks: "active", history: "active", tabs: "active", ...(safariCookies ? { cookies: "active" as const } : {}) }, 1);
  try {
    const data = await api.importSafariDirect({ signal });
    const failed: ImportKind[] = [];
    const counts = await applySafari(target, data, safariCookies, (k) => failed.push(k), destination, consent);
    updateStatus(signal, () => ({ bookmarks: "done", history: "done", tabs: "done", ...(safariCookies ? { cookies: failed.includes("cookies") ? "failed" : ("done" as const) } : {}) }));
    finishImport(signal, { counts, failures: [...new Set(failed)].map((kind) => ({ kind, profiles: [] })), notes: destination?.current() ? [] : [IMPORT_DESTINATION_CHANGED], extensions: NO_EXTENSIONS });
    noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
  } catch (e) {
    const { code } = ardiaError(e);
    if (code === "cancelled" || signal.aborted) return;
    patchImport({
      step: {
        name: "safari",
        error: code === "locked" ? "Ardia still doesn't have Full Disk Access. Grant it above, or use the export file below." : "Couldn't read Safari's data. Try the export file below.",
      },
      fullDiskAccess: api.safariHasFullDiskAccess(),
    });
  }
}

export async function importBookmarksHtml() {
  const api = importModule();
  const signal = importSignal();
  const consent = consentToken();
  const path = await api.chooseImportFile("bookmarksHTML");
  if (!path || signal.aborted) return;
  try {
    const root = await api.importBookmarksHTML(path);
    const bookmarks = importBookmarks(importNow().target, root, "HTML File");
    noteUntitledBookmarks(untitledLinks(root), consent);
    patchImport({ source: null, step: { name: "done", counts: { ...emptyCounts(), bookmarks }, failures: [], notes: [], extensions: NO_EXTENSIONS } });
  } catch {
    if (!signal.aborted) patchImport({ step: { name: "choose", error: "The selected file is invalid. Please try again." } });
  }
}
