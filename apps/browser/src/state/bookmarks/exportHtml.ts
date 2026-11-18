import { exportBookmarksHtml } from "../../platform/bookmarks";
import { revealFile } from "../../platform/files";
import { engineProfile, engineProfileForSpace, resolveWindowId } from "../browser/model";
import { profileEngine } from "../profiles/current";
import { useBrowser } from "../browser/store";
import { spaceOfWindow } from "./bookmarkGroups";
import { showToast } from "../app/toasts";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { noteBookmarkExport, noteBookmarkExportFailure } from "../telemetry/exportCounts";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export const exportProfileBookmarks = (profileId: string): Promise<string | null> => exportBookmarksHtml(profileEngine(profileId));

export async function exportBookmarks(spaceId: string): Promise<string | null> {
  const consent = consentToken();
  try {
    const path = await exportBookmarksHtml(engineProfile(useBrowser.getState(), spaceId));
    if (path) noteBookmarkExport(consent);
    return path;
  } catch (error) {
    noteBookmarkExportFailure(consent);
    throw error;
  }
}

export async function exportBookmarksFromWindow(windowId: string | null | undefined) {
  const target = resolveWindowId(useBrowser.getState(), windowId) ?? null;
  const consent = consentToken();
  try {
    const path = await exportBookmarks(spaceOfWindow(target));
    if (path && target) showToast(target, "Bookmarks exported", fileName(path), { icon: "book", action: { title: `Show in ${PLATFORM_TERMS.fileManager}`, run: () => void revealFile(path) } });
  } catch (error) {
    if (target) showToast(target, "Couldn't export bookmarks", (error as Error).message);
    else warnFor(consent, "[bookmarks] export failed", error);
  }
}
