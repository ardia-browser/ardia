import { workspaceUpgradeError } from "./platform/documents";
import { openWindow } from "./platform/windows";
import { Box, Text } from "./components/ui";
import "./platform/nativeEvents";
import "./state/tabs/profileMoveCheck";
import { useEffect, useLayoutEffect, useState } from "react";
import { AppRegistry, unstable_batchedUpdates } from "react-native";
import { WindowRoot } from "./App";
import { DevErrorBoundary } from "./components/window/DevErrorBoundary";
import { startTranslate } from "./state/site/translate";
import { startReader } from "./state/reader/reader";
import { startHiddenElements } from "./state/site/hiddenElements";
import { afterFirstWindow, firstWindowCommitted } from "./lib/afterFirstWindow";
import { startAppIntegration } from "./state/app/appIntegration";
import { startProgramControl } from "./state/app/programControl";
import { startAutomation } from "./state/automation/controlSocket";
import { startPlugins } from "./state/plugins/start";
import { startDecideHooks } from "./state/automation/decideHooks";
import { startOpenWhenDone } from "./state/windows/downloadWatch";
import { startUserScripts } from "./state/extensions/userScripts";
import { startKillSwitches } from "./platform/killSwitchesLaunch";
import { startMemoryTrim } from "./state/tabs/memoryTrim";
import { startNativeSync } from "./state/app/nativeSync";
import { startPersistence } from "./state/session/persist";
import { noteRestoredWindowsNow } from "./state/sidebar/launchRows";
import { configRestoreSession, startConfigFiles } from "./state/config/configFiles";
import { colorRoles } from "./components/ui/tokens";
import { startFavicons } from "./state/favicons/favicons";
import { startHistory } from "./state/history/engineSync";
import { startBookmarks } from "./state/bookmarks/engineSync";
import { startProfileDataCleanup } from "./state/spaces/spaceData";
import { startProfileLoading } from "./state/profiles/profileLoading";
import { startProfileUnloading } from "./state/profiles/profileUnloading";
import { startPrivateSessions } from "./state/windows/privateSessions";
import { startNewTabBar } from "./state/omnibox/newTabBar";
import { perfMark, perfProbeEnabled, probeStore } from "./state/app/perfProbe";
import { startTabLifecycle } from "./state/tabs/tabLifecycle";
import { startBusyTabWatch } from "./state/tabs/busyTabWatch";
import { startTabPages } from "./state/tabs/tabPages";
import { startTabReveal } from "./state/tabs/tabReveal";
import { startSync } from "./state/sync/engine";
import { settingsSyncWaitsAtLaunch } from "./state/sync/settingsSyncAtLaunch";
import { startSharedFolders } from "./state/sharedFolders/engine";
import { setStoreBatching, useBrowser } from "./state/browser/store";
import { installErrorReporting, startTelemetry } from "./state/telemetry";
import { launchCommitted } from "./state/telemetry/journeys";
import { consentToken } from "./state/telemetry/choice";
import { markFirstWindow } from "./state/telemetry/track";
import { noteWindowRoot } from "./state/telemetry/windowRootCounts";

probeStore("browser", useBrowser);
setStoreBatching(unstable_batchedUpdates);
const upgradeError = workspaceUpgradeError();
let launchConsent: ReturnType<typeof consentToken> = null;
if (!upgradeError) {
installErrorReporting();
startPersistence({ restoreSession: configRestoreSession(), retiredDefaultsWaitForSync: settingsSyncWaitsAtLaunch() });
noteRestoredWindowsNow();
startConfigFiles(colorRoles);
startDecideHooks();
startProfileLoading();
startProfileUnloading();
startFavicons();
startHistory();
startBookmarks();
startProfileDataCleanup();
startPrivateSessions();
startNewTabBar();
startTabPages();
startTabReveal();
startNativeSync();
startAppIntegration();
startTabLifecycle();
startTranslate();
startReader();
startHiddenElements();
startSync();
startTelemetry();
launchConsent = consentToken();
startKillSwitches();
startProgramControl();
startOpenWhenDone();
afterFirstWindow(startUserScripts);
afterFirstWindow(startAutomation);
afterFirstWindow(startPlugins);
afterFirstWindow(startSharedFolders);
afterFirstWindow(startBusyTabWatch);
startMemoryTrim();
} else {
  void openWindow("workspace-recovery", { kind: "settings", title: "Workspace needs attention" });
}
if (!upgradeError && (__DEV__ || perfProbeEnabled)) require("./components/dev/devHarness").startDevHarness();

const devMountDelay = () => (__DEV__ ? ((globalThis as { acDevMountDelayMs?: number }).acDevMountDelayMs ?? 0) : 0);

function Root({ windowId }: { windowId: string }) {
  const [renderedAt] = useState(Date.now);
  const [delay] = useState(devMountDelay);
  const [held, setHeld] = useState(delay > 0);
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), delay);
    return () => clearTimeout(timer);
  }, []);
  useLayoutEffect(() => launchCommitted(launchConsent, renderedAt), []);
  useLayoutEffect(() => noteWindowRoot(windowId), [windowId]);
  useEffect(() => {
    perfMark("firstWindow");
    markFirstWindow();
    firstWindowCommitted();
  }, []);
  if (upgradeError) return <Box pad="xxl" gap="l"><Text size="title">Your saved workspace was kept</Text><Text>{upgradeError}</Text><Text>Quit this build and restore the matching app-data backup before trying an older build.</Text></Box>;
  if (held) return null;
  return __DEV__ ? (
    <DevErrorBoundary>
      <WindowRoot windowId={windowId} />
    </DevErrorBoundary>
  ) : (
    <WindowRoot windowId={windowId} />
  );
}

AppRegistry.registerComponent("main", () => Root);
perfMark("bundleEnd");
