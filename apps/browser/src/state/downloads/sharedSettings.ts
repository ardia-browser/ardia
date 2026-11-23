import { getDownloadSettings, setDownloadSettings, type DownloadSettings } from "../../platform/downloads";
import { orWarn } from "../../lib/fallback";
import type { BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { engineProfiles } from "../profiles/engineProfiles";
import { consentToken } from "../telemetry/consentPeriod";
import { noteNewProfileDownloadsShared, noteNewProfileDownloadsShareFailed } from "../telemetry/downloadFolderCounts";
import { inDownloadTurn } from "./downloadTurns";

type SourceRead = { from: string; settings: DownloadSettings };

export async function readExistingSource(get: () => Pick<BrowserState, "profiles">, sourceNow: () => string | undefined): Promise<SourceRead | null> {
  const exists = (engine: string) => engineProfiles(get()).includes(engine);
  const from = sourceNow();
  if (from === undefined || !exists(from)) return null;
  const settings = await getDownloadSettings(from).catch((error: unknown) => {
    if (exists(from)) throw error;
    return null;
  });
  const read = settings && { from, settings };
  return exists(from) ? read : ((await readExistingSource(get, sourceNow)) ?? read);
}

export function shareDownloadsWithNewProfile(get: () => Pick<BrowserState, "profiles" | "settings">, to: string) {
  const consent = consentToken();
  const before = get();
  const defaultThen = engineProfile(before, before.settings.defaultProfileId);
  const existedBefore = engineProfiles(before);
  const exists = (engine: string) => engineProfiles(get()).includes(engine);
  const wanted = () => !get().settings.separateDownloadFolders && exists(to);
  const sourceNow = () => {
    const { profiles, settings } = get();
    return [defaultThen, engineProfile({ profiles }, settings.defaultProfileId), ...existedBefore].find((engine) => existedBefore.includes(engine) && exists(engine));
  };
  const share = async () => {
    if (!wanted()) return;
    const shared = (await readExistingSource(get, sourceNow))?.settings;
    if (!shared?.folder || shared.managed || !wanted()) return;
    await setDownloadSettings({ folder: shared.folder, askWhereToSave: shared.askWhereToSave }, to);
    noteNewProfileDownloadsShared(consent);
  };
  inDownloadTurn(share).catch((error: unknown) => {
    orWarn(undefined)(error);
    noteNewProfileDownloadsShareFailed(consent);
  });
}
