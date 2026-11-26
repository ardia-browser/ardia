import { lastFocusedEligibleWindow } from "../automation/automationWindows";
import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/choice";
import { sleepPlugin } from "./activation";
import { runPluginCommand } from "./commands";
import { dropNetChannels } from "./netChannels";
import { forgetPluginNotifications, watchPluginNotifications } from "./osApis";
import { revokeTabLease, watchTabLeases } from "./pageApis";
import { dropPluginWorlds, injectedTabsOf, pausePluginScripts, reconcileAllTabs, startPageWorlds } from "./pageWorlds";
import { onProcessStopped } from "./process";
import { dropServices } from "./services";
import { sidecarRunOf, stopSidecar } from "./sidecarPipe";
import { reconcilePlugins } from "./lifecycle";
import { loadSiteScriptBlocks } from "./siteScriptBlocks";
import { forgetSurfaceRevs } from "./surfacePatch";
import { mountedCountOf } from "./surfaces";
import { waitingCallsOf } from "./tools";
import { forgetWatchdog, startWatchdog } from "./watchdog";
import { watchPluginInputModes } from "./inputModes";
import { heldByArdia, provideShortcutSources } from "../commands/commandCatalog";
import { pluginShortcutSignature, pluginShortcutSources } from "./pluginMenuBar";

let started = false;

export function startRuntimeV3() {
  if (started) return;
  started = true;
  loadSiteScriptBlocks();
  startPageWorlds();
  watchTabLeases();
  watchPluginInputModes();
  provideShortcutSources(() => pluginShortcutSources(heldByArdia), () => pluginShortcutSignature());
  watchPluginNotifications((plugin, command) => {
    const windowId = lastFocusedEligibleWindow(useBrowser.getState());
    if (windowId) void runPluginCommand(plugin, command, windowId).catch(() => undefined);
  });
  startWatchdog({
    stop: sleepPlugin,
    sleep: sleepPlugin,
    busy: (name) => mountedCountOf(name) > 0 || waitingCallsOf(name) > 0,
    contentTabs: (name) => injectedTabsOf(name).length,
    pauseScripts: pausePluginScripts,
    resume: reconcilePlugins,
    sidecarRun: sidecarRunOf,
  });
  onProcessStopped((name) => {
    dropNetChannels(name);
    dropServices(name);
    stopSidecar(name);
    revokeTabLease(name);
    forgetSurfaceRevs(name);
    forgetWatchdog(name);
    forgetPluginNotifications(name);
    dropPluginWorlds(name);
  });
  void reconcileAllTabs(consentToken());
}
