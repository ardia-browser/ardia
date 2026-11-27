import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESKTOP_MODES } from "../desktopModes.ts";

const SHARED_TESTS = [
  "host.test.mjs", "hostContract.test.mjs", "hostTabReplacement.test.mjs", "liveDocuments.test.mjs",
  "nativeMenuBar.test.mjs", "popoverSurface.test.mjs", "appMenuPlacement.test.mjs", "nativeDownloads.test.mjs",
  "livePersistenceBinding.test.mjs", "liveCompletionPersistence.test.mjs", "hostDocumentTransport.test.mjs",
  "windowCloseLifecycle.test.mjs", "hostSessionMerge.test.mjs", "hostSessionSync.test.mjs",
  "sessionWriterRebase.test.mjs", "session.test.mjs", "sessionShells.test.mjs", "settingsWindows.test.mjs", "hostViewport.test.mjs",
  "pageFocus.test.mjs", "hostDialogs.test.mjs", "hostDialogConsumers.test.mjs",
  "hostProfiles.test.mjs", "windowLifecycle.test.mjs", "hostDownloads.test.mjs", "hostPrivateWindows.test.mjs",
  "hostSmallWindows.test.mjs", "windowMenu.test.mjs", "hostFiles.test.mjs", "fileDrop.test.mjs",
  "hostPageCommands.test.mjs", "suggestionCsp.test.mjs", "hostSuggestions.test.mjs", "hostCapabilities.test.mjs",
  "editCommands.test.mjs", "fullScreen.test.mjs", "notifications.test.mjs", "hostConfig.test.mjs",
  "settingsCapabilities.test.mjs", "appServices.test.mjs", "browserCommandRoute.test.mjs", "hostPageEvents.test.mjs",
  "hostPagePrompts.test.mjs", "hostTabPage.test.mjs", "hostCredentials.test.mjs", "hostExtensions.test.mjs",
  "hostSiteControls.test.mjs", "hostImport.test.mjs", "importUnlock.test.mjs", "hostPageStatus.test.mjs",
  "hostMedia.test.mjs", "windowSweep.test.mjs", "typeahead.test.mjs", "mountLayout.test.mjs", "webShims.test.mjs", "fieldKeys.test.mjs",
  "profilePaging.test.mjs", "pagerMotion.test.mjs", "shellMethods.test.mjs", "hostFolders.test.mjs", "extensionPrompts.test.mjs",
  "hostSync.test.mjs", "syncToggles.test.mjs", "pageOperations.test.mjs", "hostPolicies.test.mjs", "quit.test.mjs", "hostLive.test.mjs",
  "hostExtensionScripts.test.mjs", "installRequestSheet.test.mjs", "utilityExtensions.test.mjs",
  "windowDrag.test.mjs", "hostHistoryImports.test.mjs", "popoverEscape.test.mjs", "entryOrder.test.mjs",
  "unclaimedTabs.test.mjs", "appMenu.test.mjs", "inputRegions.test.mjs", "downloadsDismissal.test.mjs",
  "menus.test.mjs", "tileLetters.test.mjs", "shortcutsComposing.test.mjs", "downloadsRightClick.test.mjs", "shellAbove.test.mjs", "pipPlayer.test.mjs", "glassRegions.test.mjs", "behindWindowGlass.test.mjs", "telemetryLeader.test.mjs",
  "linkShare.test.mjs", "hostTelemetryLocal.test.mjs", "hostTelemetryChoice.test.mjs", "shellMigrationLaunch.test.mjs",
  "inWindowPlayerConsent.test.mjs", "settingsViewData.test.mjs", "sessionMigrations.test.mjs",
  "bookmarksHtml.test.mjs", "hostBookmarksExport.test.mjs", "openUrls.test.mjs", "pageSwipe.test.mjs",
  "hostReport.test.mjs", "engineCapabilities.test.mjs", "hostAppearance.test.mjs", "tabSwitchAhead.test.mjs",
  "shellPainted.test.mjs", "introMusic.test.mjs", "hostCrashReports.test.mjs", "windowControls.test.mjs",
  "readerService.test.mjs", "hostKillSwitches.test.mjs", "fieldTiming.test.mjs", "launchMeasure.test.mjs",
  "keyringTelemetry.test.mjs", "textInputCaret.test.mjs", "peekStageMotion.test.mjs", "popoverPlacement.test.mjs",
  "popoverHost.test.mjs", "nativeTrafficLights.test.mjs", "scrollGestures.test.mjs", "liquidGlass.test.mjs", "filmGrain.test.mjs", "backdropTheme.test.mjs",
  "nativeSettingsHost.test.mjs", "hostTabClose.test.mjs", "profileRetirement.test.mjs"
];

const MODE_TESTS = { linux: ["shortcuts.test.mjs"], win: ["shortcuts.test.mjs"], mac: [] };

const root = fileURLToPath(new URL("../", import.meta.url));
const platformTests = (mode) =>
  readdirSync(new URL(`../src/platform/${mode}/`, import.meta.url), { recursive: true })
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => `platform/${mode}/${file}`)
    .sort();

const asked = process.argv.slice(2);
const modes = asked.length ? asked : DESKTOP_MODES;
for (const mode of modes) if (!DESKTOP_MODES.includes(mode)) throw new Error(`unknown desktop mode ${mode}; use ${DESKTOP_MODES.join(" or ")}`);

let failed = false;
for (const mode of modes) {
  const files = [...SHARED_TESTS, ...MODE_TESTS[mode], ...platformTests(mode)].map((file) => `src/${file}`);
  console.log(`# test:host --mode ${mode}: ${files.length} files`);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/host-test-loader.mjs", "--test", ...files], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ARDIA_DESKTOP_MODE: mode },
  });
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
