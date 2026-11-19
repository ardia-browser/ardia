import type { AppNative } from "@ardia/shell";
import { requireNativeModule } from "../modules";
import type { Check } from "./check";
import { checks as appSystemChecks } from "./appSystem";
import { checks as engineCallChecks } from "./engineCalls";
import { checks as engineHostChecks } from "./engineHost";
import { checks as passwordLoginChecks, stageChecks } from "./passwordLogins";
import { checks as engineBackForwardChecks } from "./engineBackForward";
import { checks as engineTopEdgeChecks } from "./engineTopEdge";
import { checks as engineSleepChecks } from "./engineSleep";
import { checks as engineLinkScriptChecks } from "./engineLinkScript";
import { checks as engineLinkScriptPageChecks } from "./engineLinkScriptPages";
import { checks as engineSleepKeptChecks } from "./engineSleepKept";
import { checks as engineSleepNavigationChecks } from "./engineSleepNavigation";
import { checks as engineSleepPlaceChecks } from "./engineSleepPlace";
import { checks as engineBlankChecks } from "./engineBlank";
import { checks as engineHistoryChecks } from "./engineHistory";
import { checks as engineSettingsChecks } from "./engineSettingsPages";
import { popupWindowChecks } from "./popupWindow";
import { checks as externalAppChecks } from "./externalApps";
import { checks as fileDropChecks } from "./fileDrop";
import { checks as heldDialogChecks } from "./heldDialogs";
import { checks as heldMenuChecks } from "./heldMenus";
import { checks as desktopCallChecks } from "./desktopCalls";
import { checks as focusChecks } from "./focus";
import { checks as idleTimeChecks } from "./idleTime";
import { checks as importChecks } from "./importFiles";
import { checks as introMusicChecks } from "./introMusic";
import { checks as meadowChecks } from "./meadow";
import { checks as importFirefoxChecks } from "./importFirefox";
import { checks as launchLinkChecks } from "./launchLinks";
import { checks as materialChecks } from "./materials";
import { checks as menuChecks } from "./menus";
import { checks as motionChecks } from "./motion";
import { checks as pagePictureChecks } from "./pagePicture";
import { checks as pagerChecks } from "./pager";
import { registeredChecks } from "./registered";
import { checks as shellChecks } from "./shell";
import { checks as storageChecks } from "./storage";
import { checks as symbolChecks } from "./symbol";
import { checks as syncChecks } from "./sync";
import { checks as textFocusChecks } from "./textFocus";
import { checks as viewChecks } from "./views";
import { checks as windowDragChecks } from "./windowDrag";
import { checks as windowChecks } from "./windows";
import { checks as engineLaunchLogChecks } from "./engineLaunchLog";
import { checks as engineContentsBackgroundChecks } from "./engineContentsBackground";

const areas: Check[][] = [windowChecks, appSystemChecks, shellChecks, storageChecks, viewChecks, menuChecks, symbolChecks, motionChecks, pagerChecks, pagePictureChecks, materialChecks, windowDragChecks, popupWindowChecks, fileDropChecks, focusChecks, idleTimeChecks, textFocusChecks, launchLinkChecks, engineHostChecks, engineLaunchLogChecks, engineBackForwardChecks, engineTopEdgeChecks, engineSleepChecks, engineLinkScriptChecks, engineLinkScriptPageChecks, engineSleepKeptChecks, engineSleepNavigationChecks, engineSleepPlaceChecks, engineBlankChecks, engineContentsBackgroundChecks, engineHistoryChecks, engineCallChecks, importChecks, importFirefoxChecks, introMusicChecks, desktopCallChecks, externalAppChecks, syncChecks, heldDialogChecks, heldMenuChecks, meadowChecks, passwordLoginChecks, engineSettingsChecks];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runSelfCheck() {
  let passed = 0;
  let failed = 0;
  const only = requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test.selfCheckOnly;
  for (const check of stageChecks() ?? [...areas.flat(), ...registeredChecks()].filter((each) => !only || each.name.startsWith(only))) {
    try {
      await check.run();
      passed += 1;
      console.info(`[ardia windows] self-check pass: ${check.name}`);
    } catch (error) {
      failed += 1;
      console.info(`[ardia windows] self-check FAIL: ${check.name}: ${message(error)}`);
    }
  }
  console.info(`[ardia windows] self-check done: ${passed} passed, ${failed} failed`);
}
