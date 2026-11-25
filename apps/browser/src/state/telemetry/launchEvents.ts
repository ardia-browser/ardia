import { useBrowser } from "../browser/store";
import { capture, type ConsentToken, type startClient } from "./usageClient";
import { contextProperties, hardwareProperties, launchGuardProperties } from "./diagnostics";
import { topAppsSharingAtLaunch } from "./topAppsSharing";
import { appInfo } from "./transport";
import { engineMatchProperties } from "./engineMatch";
import { noteLaunchConsent, reportShellMigrationAtLaunch } from "./shellMigrationLaunch";

const rebootedSince = (lastLaunchAt: number | null) => {
  const boot = appInfo().bootTime;
  return lastLaunchAt != null && boot != null ? boot > lastLaunchAt : null;
};

export async function launchEvents(session: ReturnType<typeof startClient>, consent: ConsentToken | null) {
  noteLaunchConsent(consent);
  const topApps = topAppsSharingAtLaunch(useBrowser.getState(), session.updatedFrom);
  const hardware = await hardwareProperties();
  const previous = session.previous === "unclean" ? { ...contextProperties(session.context, "prev_", Date.now()), rebooted_since: rebootedSince(session.lastLaunchAt) } : {};
  capture("app_launched", { previous_session: session.previous, ...hardware, ...previous, ...launchGuardProperties(), ...engineMatchProperties(appInfo().engineMatch) }, consent);
  if (session.updatedFrom) capture("app_updated", { from_version: session.updatedFrom }, consent);
  capture("top_apps_sharing", topApps, consent);
  await reportShellMigrationAtLaunch(consent);
}
