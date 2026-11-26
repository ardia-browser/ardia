import { consentEpoch } from "../../browser/src/state/telemetry/client";
import { closeWindow, emitCommand } from "@ardia/shell";
import { useBrowser } from "../../browser/src/state/browser/store";
import { appMenuChoice, appMenuCommandEvent } from "./appMenu";
import { minimizeAllWindows } from "./windowMenu";
import { currentEditTarget, runEdit } from "./editTargets";
import { ardiaHost, hostModuleMethod, reportHostError } from "./host";
import { linuxCapabilities, unavailableCommands } from "./hostCapabilities";
import { videoTourUrl } from "../../browser/src/state/onboarding/tour";
import { showToast } from "../../browser/src/state/app/toasts";
import { checkForUpdates, engineInfo, systemInfo } from "../../browser/src/platform/app";
import { runMenuUpdate } from "@platform/updater";
import { isMoreShareChoice, openSharingSettings } from "./hostShare";

export type AppMenuChoice = NonNullable<ReturnType<typeof appMenuChoice>>;

export const hiddenAppMenuCommands = () => {
  const hidden = unavailableCommands(linuxCapabilities());
  hidden.delete("emailPageLocation");
  if (!videoTourUrl()) hidden.add("videoTour");
  if (!systemInfo().releaseNotesURL) hidden.add("releaseNotes");
  return hidden;
};

async function showAbout(windowId: string) {
  const { appName, appVersion, appBuild } = systemInfo();
  const engine = await engineInfo().catch(() => null);
  showToast(windowId, `${appName} ${appVersion} (${appBuild})`, engine?.chromiumVersion ? `ArdiaCore on Chromium ${engine.chromiumVersion}` : undefined);
}

export function runAppMenuChoice(windowId: string, choice: AppMenuChoice | null, editTarget = currentEditTarget()): Promise<void> | void {
  if (!choice) return;
  if (choice.kind === "about") return showAbout(windowId);
  if (choice.kind === "updates") {
    const update = ardiaHost ? runMenuUpdate(ardiaHost, choice.restart) : null;
    return void (update ?? checkForUpdates()).catch(reportHostError);
  }
  if (choice.kind === "edit") return runEdit(windowId, choice.action, editTarget).catch(reportHostError);
  if (choice.kind === "command" && isMoreShareChoice(choice.command, choice.arg)) return void openSharingSettings(ardiaHost).catch(reportHostError);
  if (choice.kind === "command") return emitCommand(appMenuCommandEvent(choice, windowId, consentEpoch()));
  if (choice.action === "close") return void closeWindow(windowId).catch(reportHostError);
  if (choice.action === "minimizeAll") return void minimizeAllWindows(useBrowser.getState().windowOrder);
  void hostModuleMethod("ArdiaShell", choice.action === "minimize" ? "minimizeWindow" : "toggleMaximizeWindow")(windowId).catch(reportHostError);
}
