import type { ArdiaHost } from "./host";
import { AUR_UPDATE_COMMAND, linuxUpdater, scheduleUpdateChecks, updatesAvailable, linuxSwitchesFetch, killSwitchesAvailable, type LinuxUpdater, type UpdateLocks } from "./hostUpdates.ts";
import { isLinuxUtility } from "./session.ts";
import { refreshDocument } from "./shims/shellBase";
import { systemInfo } from "../../browser/src/platform/app";
import { copyText } from "../../browser/src/platform/clipboard";
import { confirm } from "../../browser/src/platform/dialogs";
import { readDocument, saveDocument } from "../../browser/src/platform/documents";
import { startKillSwitches } from "../../browser/src/platform/killSwitchesLaunch";
import { showToast } from "../../browser/src/state/app/toasts";
import { openUrls } from "../../browser/src/state/browser/actions";
import { openUrlFromSettings } from "../../browser/src/state/settings/settingsWindows";
import { noteSwitchRefresh, noteUpdatePageOpened } from "../../browser/src/state/telemetry/updateCounts.ts";

const updaters = new WeakMap<ArdiaHost, LinuxUpdater>();
const UPDATE_ICON = "arrow.down.circle";

const browserLocks = (): UpdateLocks | undefined => (typeof navigator === "undefined" ? undefined : (navigator as { locks?: UpdateLocks }).locks);

export function linuxUpdaterFor(host: ArdiaHost): LinuxUpdater {
  const known = updaters.get(host);
  if (known) return known;
  const windowId = host.bootstrap.windowId;
  const browserWindow = !isLinuxUtility(windowId);
  const open = (url: string) => (browserWindow ? openUrls([url], windowId) : openUrlFromSettings(url));
  const toast: typeof showToast = (...args) => {
    if (browserWindow) showToast(...args);
  };
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
    ask: (release, current, failed) =>
      confirm({
        title: `Ardia ${release.version} is available`,
        message: failed
          ? `You have Ardia ${current}. Ardia couldn't install the update itself: download the new package from its release page.`
          : `You have Ardia ${current}. Ardia on Linux doesn't update itself: download the new package from its release page.`,
        confirmTitle: "Open Release Page",
        cancelTitle: "Later",
        windowId,
      }).then((answer) => answer.confirmed, () => false),
    tell: async (title, message) => toast(windowId, title, message, { icon: UPDATE_ICON }),
    offer: (release, failed) =>
      toast(windowId, `Ardia ${release.version} is available`, failed ? "Ardia couldn't install it. Download it from its release page." : "Download it from its release page.", {
        icon: UPDATE_ICON,
        sticky: true,
        action: { title: "View", run: () => (noteUpdatePageOpened(), open(release.url)) },
      }),
    offerInstall: (release, install) =>
      toast(windowId, `Ardia ${release.version} is available`, "Update now and restart when you're ready.", {
        icon: UPDATE_ICON,
        sticky: true,
        action: { title: "Update", run: install },
      }),
    ready: (version, restart) =>
      toast(windowId, `Ardia ${version} is ready`, "Restart to finish updating.", {
        icon: UPDATE_ICON,
        sticky: true,
        action: { title: "Restart", run: restart },
      }),
    managed: async (release, current, asked) => {
      if (!asked) {
        toast(windowId, `Ardia ${release.version} is available`, `Update it with your package manager, like ${AUR_UPDATE_COMMAND}.`, { icon: UPDATE_ICON, sticky: true });
        return;
      }
      const answer = await confirm({
        title: `Ardia ${release.version} is available`,
        message: `You have Ardia ${current}. Your package manager installed Ardia, so update it there: for the AUR package, run ${AUR_UPDATE_COMMAND} or use your AUR helper.`,
        confirmTitle: "Copy Command",
        cancelTitle: "OK",
        windowId,
      }).catch(() => null);
      if (answer?.confirmed) copyText(AUR_UPDATE_COMMAND);
    },
    open,
    showsToasts: browserWindow,
    locks: browserLocks(),
  });
  updaters.set(host, updater);
  return updater;
}

const MENU_STATUS_WAIT_MS = 150;

export const updateMenuItem = async (host: ArdiaHost): Promise<"check" | "restart" | null> => {
  if (!updatesAvailable(host) || host.bootstrap.privateWindow) return null;
  const late = new Promise<"check">((resolve) => setTimeout(() => resolve("check"), MENU_STATUS_WAIT_MS));
  return Promise.race([linuxUpdaterFor(host).menuItem(), late]);
};

export function startLinuxUpdates(host: ArdiaHost, locks?: LockManager) {
  if (killSwitchesAvailable(host)) startKillSwitches(linuxSwitchesFetch(host, fetch.bind(globalThis)), noteSwitchRefresh);
  if (!updatesAvailable(host) || host.bootstrap.privateWindow) return;
  scheduleUpdateChecks(linuxUpdaterFor(host), { locks: locks as unknown as Parameters<typeof scheduleUpdateChecks>[1]["locks"] });
}
