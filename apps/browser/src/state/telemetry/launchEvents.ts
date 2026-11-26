import { useBrowser } from "../browser/store";
import { capture, type ConsentToken, type startClient } from "./usageClient";
import { contextProperties, hardwareProperties, launchGuardProperties } from "./diagnostics";
import { shellRecoveryProperties } from "./shellRecovery";
import { topAppsSharingAtLaunch } from "./topAppsSharing";
import { appInfo } from "./transport";
import { call } from "../../platform/engine";
import { engineMatchProperties } from "./engineMatch";
import { noteLaunchConsent, reportShellMigrationAtLaunch } from "./shellMigrationLaunch";

const rebootedSince = (lastLaunchAt: number | null) => {
  const boot = appInfo().bootTime;
  return lastLaunchAt != null && boot != null ? boot > lastLaunchAt : null;
};

const hostCount = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 16) : null);

export function nativeMessagingProperties(hosts: { found?: unknown; registered?: unknown; keptTheirs?: unknown; missing?: unknown; unusable?: unknown } | null | undefined) {
  if (!hosts || typeof hosts !== "object") return {};
  return {
    native_messaging_hosts: hostCount(hosts.found),
    native_messaging_registered: hostCount(hosts.registered),
    native_messaging_kept_theirs: hostCount(hosts.keptTheirs),
    native_messaging_missing: hostCount(hosts.missing),
    native_messaging_unusable: hostCount(hosts.unusable),
  };
}

const probeNativeMessaging = (consent: ConsentToken | null) => (consent ? call("engine.nativeMessagingHosts", {}).catch(() => null) : Promise.resolve(null));

export async function launchEvents(session: ReturnType<typeof startClient>, consent: ConsentToken | null) {
  noteLaunchConsent(consent);
  const topApps = topAppsSharingAtLaunch(useBrowser.getState(), session.updatedFrom);
  const nativeMessaging = probeNativeMessaging(consent);
  const hardware = await hardwareProperties();
  const previous = session.previous === "unclean" ? { ...contextProperties(session.context, "prev_", Date.now()), rebooted_since: rebootedSince(session.lastLaunchAt) } : {};
  capture("app_launched", { previous_session: session.previous, ...hardware, ...previous, ...launchGuardProperties(), ...shellRecoveryProperties(), ...engineMatchProperties(appInfo().engineMatch), ...nativeMessagingProperties(await nativeMessaging) }, consent);
  if (session.updatedFrom) capture("app_updated", { from_version: session.updatedFrom }, consent);
  capture("top_apps_sharing", topApps, consent);
  await reportShellMigrationAtLaunch(consent);
}
