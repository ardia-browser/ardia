import type { ArdiaHost } from "../../host";
import { WINDOWS_RELEASE_PAGE, installerSize, named, scheduleUpdateChecks, updatesAvailable, windowsUpdater, type UpdateLocks, type WindowsUpdater } from "./hostUpdates.ts";
import { isLinuxUtility } from "../../session.ts";
import { refreshDocument } from "../../shims/shellBase";
import { confirm } from "../../../../browser/src/platform/dialogs";
import { readDocument, saveDocument } from "../../../../browser/src/platform/documents";
import { showToast } from "../../../../browser/src/state/app/toasts";
import { openUrls } from "../../../../browser/src/state/browser/actions";
import { openUrlFromSettings } from "../../../../browser/src/state/settings/settingsWindows";
import { noteUpdateNoticeDismissed, noteUpdatePageOpened } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { consentToken } from "../../../../browser/src/state/telemetry/consentPeriod";

const updaters = new WeakMap<ArdiaHost, WindowsUpdater>();
const UPDATE_ICON = "arrow.down.circle";
const MENU_STATUS_WAIT_MS = 150;

const browserLocks = (): UpdateLocks | undefined => (typeof navigator === "undefined" ? undefined : (navigator as { locks?: UpdateLocks }).locks);

export function windowsUpdaterFor(host: ArdiaHost): WindowsUpdater {
  const known = updaters.get(host);
  if (known) return known;
  const windowId = host.bootstrap.windowId;
  const browserWindow = !isLinuxUtility(windowId);
  const open = (url: string) => (browserWindow ? openUrls([url], windowId) : openUrlFromSettings(url));
  const toast: typeof showToast = (...args) => {
    if (browserWindow) showToast(...args);
  };
  const updater = windowsUpdater({
    host,
    read: readDocument,
    write: saveDocument,
    refresh: refreshDocument,
    pointToRelease: (title, message) => {
      if (browserWindow) {
        return void showToast(windowId, title, message, {
          icon: UPDATE_ICON,
          sticky: true,
          action: { title: "Open Release Page", run: () => (noteUpdatePageOpened(), open(WINDOWS_RELEASE_PAGE)) },
          secondary: { title: "Later", run: noteUpdateNoticeDismissed },
        });
      }
      const consent = consentToken();
      void confirm({ title, message, confirmTitle: "Open Release Page", cancelTitle: "Later", windowId }).then(
        (answer) => answer.confirmed && (noteUpdatePageOpened(consent), open(WINDOWS_RELEASE_PAGE)),
        () => console.info(`[ardia windows] ${title}: ${message}`),
      );
    },
    tell: async (title, message) => {
      if (browserWindow) return showToast(windowId, title, message, { icon: UPDATE_ICON });
      void confirm({ title, message, confirmTitle: "OK", cancelTitle: "", windowId }).catch(() => console.info(`[ardia windows] ${title}: ${message}`));
    },
    offer: (update, failed) =>
      toast(windowId, `Ardia ${update.version} is available`, failed ? "Ardia couldn't install it. Download the installer from its release page." : "Download the installer from its release page.", {
        icon: UPDATE_ICON,
        sticky: true,
        action: { title: "View", run: () => (noteUpdatePageOpened(), open(WINDOWS_RELEASE_PAGE)) },
        secondary: { title: "Later", run: noteUpdateNoticeDismissed },
      }),
    offerInstall: (update, install) =>
      toast(windowId, `Ardia ${update.version} is available`, `Download ${named(update)} (${installerSize(update)}) and restart when you're ready.`, {
        icon: UPDATE_ICON,
        sticky: true,
        action: { title: "Update", run: install },
        secondary: { title: "Later", run: noteUpdateNoticeDismissed },
      }),
    ready: (update, restart) =>
      toast(windowId, `Ardia ${update.version} is ready`, "Restart to finish updating. Ardia closes, installs it and opens again.", {
        icon: UPDATE_ICON,
        sticky: true,
        action: { title: "Restart", run: restart },
        secondary: { title: "Later", run: noteUpdateNoticeDismissed },
      }),
    open,
    showsToasts: browserWindow,
    locks: browserLocks(),
  });
  updaters.set(host, updater);
  return updater;
}

export const updateMenuItem = async (host: ArdiaHost): Promise<"check" | "restart" | null> => {
  if (!updatesAvailable(host) || host.bootstrap.privateWindow) return null;
  const late = new Promise<"check">((resolve) => setTimeout(() => resolve("check"), MENU_STATUS_WAIT_MS));
  return Promise.race([windowsUpdaterFor(host).menuItem(), late]);
};

export function startWindowsUpdates(host: ArdiaHost, locks?: LockManager) {
  if (!updatesAvailable(host) || host.bootstrap.privateWindow) return;
  scheduleUpdateChecks(windowsUpdaterFor(host), { locks: locks as unknown as Parameters<typeof scheduleUpdateChecks>[1]["locks"] });
}
