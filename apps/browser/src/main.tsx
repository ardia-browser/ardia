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
import { configRestoreSession, startConfigFiles } from "./state/config/configFiles";
import { colorRoles } from "./components/ui/tokens";
import { startFavicons } from "./state/favicons/favicons";
import { startHistory } from "./state/history/engineSync";
import { startBookmarks } from "./state/bookmarks/engineSync";
import { startProfileDataCleanup } from "./state/profiles/profileData";
import { startProfileLoading } from "./state/profiles/profileLoading";
import { startProfileUnloading } from "./state/profiles/profileUnloading";
import { startPrivateSessions } from "./state/windows/privateSessions";
import { startNewTabBar } from "./state/omnibox/newTabBar";
import { perfMark, perfProbeEnabled, probeStore } from "./state/app/perfProbe";
import { startTabLifecycle } from "./state/tabs/tabLifecycle";
import { startTabPages } from "./state/tabs/tabPages";
import { startTabReveal } from "./state/tabs/tabReveal";
import { startSync } from "./state/sync/engine";
import { startSharedFolders } from "./state/sharedFolders/engine";
import { setStoreBatching, useBrowser } from "./state/browser/store";
import { installErrorReporting, startTelemetry } from "./state/telemetry";
import { launchCommitted } from "./state/telemetry/journeys";
import { markFirstWindow } from "./state/telemetry/track";
import { noteWindowRoot } from "./state/telemetry/windowRootCounts";
import { systemInfo } from "./platform/app";
import { adoptUiLanguage } from "./lib/uiLanguage";

try {
  adoptUiLanguage(systemInfo().locale);
} catch {
  adoptUiLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
}

probeStore("browser", useBrowser);
installErrorReporting();
setStoreBatching(unstable_batchedUpdates);
startPersistence({ restoreSession: configRestoreSession() });
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
startKillSwitches();
startProgramControl();
startOpenWhenDone();
afterFirstWindow(startUserScripts);
afterFirstWindow(startAutomation);
afterFirstWindow(startPlugins);
afterFirstWindow(startSharedFolders);
startMemoryTrim();
if (__DEV__ || perfProbeEnabled) require("./components/dev/devHarness").startDevHarness();

const devMountDelay = () => (__DEV__ ? ((globalThis as { acDevMountDelayMs?: number }).acDevMountDelayMs ?? 0) : 0);

function Root({ windowId }: { windowId: string }) {
  const [delay] = useState(devMountDelay);
  const [held, setHeld] = useState(delay > 0);
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), delay);
    return () => clearTimeout(timer);
  }, []);
  useLayoutEffect(() => launchCommitted(), []);
  useLayoutEffect(() => noteWindowRoot(windowId), [windowId]);
  useEffect(() => {
    perfMark("firstWindow");
    markFirstWindow();
    firstWindowCommitted();
  }, []);
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
