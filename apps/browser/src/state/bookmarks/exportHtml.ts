import { exportBookmarksHtml } from "../../platform/bookmarks";
import { revealFile } from "../../platform/files";
import { engineProfile, resolveWindowId } from "../browser/model";
import { useBrowser } from "../browser/store";
import { profileOfWindow } from "./bookmarkGroups";
import { showToast } from "../app/toasts";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { noteBookmarkExport, noteBookmarkExportFailure } from "../telemetry/exportCounts";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { t } from "../../lib/uiLanguage";


const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export async function exportBookmarks(profileId: string): Promise<string | null> {
  const consent = consentToken();
  try {
    const path = await exportBookmarksHtml(engineProfile(useBrowser.getState(), profileId));
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
    const path = await exportBookmarks(profileOfWindow(target));
    if (path && target) showToast(target, t(`Bookmarks exported`), fileName(path), { icon: "book", action: { title: `Show in ${PLATFORM_TERMS.fileManager}`, run: () => void revealFile(path) } });
  } catch (error) {
    if (target) showToast(target, t(`Couldn't export bookmarks`), (error as Error).message);
    else warnFor(consent, t(`[bookmarks] export failed`), error);
  }
}
