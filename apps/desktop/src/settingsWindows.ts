import { openWindow, type OpenWindowOptions } from "../../browser/src/platform/windows";
import { goToSettingsPane, type SettingsPane, type SettingsPlace } from "../../browser/src/state/settings/settingsWindows";
import { consentToken, type ConsentToken } from "../../browser/src/state/telemetry/choice";
import { ardiaHost, reportHostError } from "./host";
import { flushLinuxSession } from "./session";

export * from "../../browser/src/state/settings/settingsWindows";

type UtilitySettingsPlace = SettingsPlace & { reveal?: string; revealId?: string; revealConsent?: ConsentToken | null };

export function openSettings(pane?: SettingsPane, profileId?: string | null, detail?: string | null, reveal?: string | null) {
  let settings: UtilitySettingsPlace | undefined;
  if (pane) {
    const revealConsent = consentToken();
    goToSettingsPane(pane, profileId ?? null, detail ?? null);
    settings = { pane, profileId: profileId ?? null, detail: detail ?? null, ...(reveal ? { reveal, revealId: crypto.randomUUID(), revealConsent } : {}) };
  }
  const options: OpenWindowOptions & { settings?: UtilitySettingsPlace } = { kind: "settings", title: "Settings", ...(settings ? { settings } : {}) };
  void flushLinuxSession().then(() => openWindow("settings", options)).catch(reportHostError);
}

let preferredImportSource = ardiaHost?.bootstrap.utility?.importSource ?? null;
export const setPreferredImportSource = (source: string) => void (preferredImportSource = source);

export function takePreferredImportSource() {
  const source = preferredImportSource;
  preferredImportSource = null;
  return source;
}

export function openImport(browserId?: string) {
  const options: OpenWindowOptions & { importSource?: string } = { kind: "import", title: "Import from Another Browser", ...(browserId ? { importSource: browserId } : {}) };
  void flushLinuxSession().then(() => openWindow("import", options)).catch(reportHostError);
}
