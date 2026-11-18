import type { ArdiaHost } from "./host";
import { linuxUpdater, scheduleUpdateChecks, updatesAvailable, linuxSwitchesFetch, killSwitchesAvailable, type LinuxUpdater } from "./hostUpdates.ts";
import { isLinuxUtility } from "./session.ts";
import { refreshDocument } from "./shims/shellBase";
import { systemInfo } from "../../browser/src/platform/app";
import { confirm } from "../../browser/src/platform/dialogs";
import { readDocument, saveDocument } from "../../browser/src/platform/documents";
import { startKillSwitches } from "../../browser/src/platform/killSwitchesLaunch";
import { showToast } from "../../browser/src/state/app/toasts";
import { openUrls } from "../../browser/src/state/browser/actions";
import { openUrlFromSettings } from "../../browser/src/state/settings/settingsWindows";
import { noteSwitchRefresh, noteUpdatePageOpened } from "../../browser/src/state/telemetry/updateCounts.ts";

const updaters = new WeakMap<ArdiaHost, LinuxUpdater>();

export function linuxUpdaterFor(host: ArdiaHost): LinuxUpdater {
  const known = updaters.get(host);
  if (known) return known;
  const windowId = host.bootstrap.windowId;
  const browserWindow = !isLinuxUtility(windowId);
  const open = (url: string) => (browserWindow ? openUrls([url], windowId) : openUrlFromSettings(url));
  const updater = linuxUpdater({
    host,
    appVersion: () => {
      try {
        return systemInfo().appVersion ?? null;
      } catch {
        return null;
      }
    },
    read: readDocument,
    write: saveDocument,
    refresh: refreshDocument,
    ask: (release, current) =>
      confirm({
        title: `Ardia ${release.version} is available`,
        message: `You have Ardia ${current}. Ardia on Linux doesn't update itself: download the new package from its release page.`,
        confirmTitle: "Open Release Page",
        cancelTitle: "Later",
        windowId,
      }).then((answer) => answer.confirmed, () => false),
    tell: async (title, message) => {
      if (browserWindow) showToast(windowId, title, message, { icon: "arrow.down.circle" });
    },
    offer: (release) =>
      showToast(windowId, `Ardia ${release.version} is available`, "Download it from its release page.", {
        icon: "arrow.down.circle",
        sticky: true,
        action: { title: "View", run: () => (noteUpdatePageOpened(), open(release.url)) },
      }),
    open,
  });
  updaters.set(host, updater);
  return updater;
}

export function startLinuxUpdates(host: ArdiaHost, locks?: LockManager) {
  if (killSwitchesAvailable(host)) startKillSwitches(linuxSwitchesFetch(host, fetch.bind(globalThis)), noteSwitchRefresh);
  if (!updatesAvailable(host) || host.bootstrap.privateWindow) return;
  scheduleUpdateChecks(linuxUpdaterFor(host), { locks: locks as unknown as Parameters<typeof scheduleUpdateChecks>[1]["locks"] });
}
