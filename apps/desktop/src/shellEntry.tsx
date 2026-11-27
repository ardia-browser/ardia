import "../../browser/src/state/browser/store";
import "./base.css";
import "./styles.css";
import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { unstable_batchedUpdates } from "react-native";
import { emitAppEvent, emitCommand, menuShown, setWindowCloseDecider } from "@ardia/shell";
import { WindowRoot } from "../../browser/src/App";
import { startNativeSync } from "../../browser/src/state/app/nativeSync";
import { startTabPages } from "../../browser/src/state/tabs/tabPages";
import { startReader } from "../../browser/src/state/reader/reader";
import { startTabLifecycle, useLifecycle } from "../../browser/src/state/tabs/tabLifecycle";
import { useMedia } from "../../browser/src/state/media/media";
import { useToolbarAutoHide } from "../../browser/src/state/windows/toolbarAutoHide";
import { noteSidebarPeekPageHidden, noteToolbarPageHidden } from "../../browser/src/state/telemetry/usage";
import { peekShown } from "../../browser/src/state/windows/dockMotion";
import { onPageCovered } from "./shims/web/HostWebView";
import { toolbarMoving } from "./AutoHideToolbarRegion";
import { copyLinkToSelection, jumpToSelection, replaceInField, usePageSelection } from "../../browser/src/state/site/selection";
import { webviews } from "../../browser/src/platform/webviews";
import { startMemoryTrim } from "../../browser/src/state/tabs/memoryTrim";
import { startProfileUnloading } from "../../browser/src/state/profiles/profileUnloading";
import { setNewTabPrewarm } from "../../browser/src/state/tabs/prewarm";
import { setStoreBatching, useBrowser, type HydrateData } from "../../browser/src/state/browser/store";
import { usePages } from "../../browser/src/state/tabs/pageState";
import { useOnboarding } from "../../browser/src/state/onboarding/onboarding";
import { adoptParkedPins } from "../../browser/src/state/pins/parkedPins";
import { decideLinuxWindowClose } from "./windowCloseDecider";
import { afterFirstWindow, firstWindowCommitted } from "../../browser/src/lib/afterFirstWindow";
import { startProgramControl } from "../../browser/src/state/app/programControl";
import { startAutomation } from "../../browser/src/state/automation/controlSocket";
import { startUserScripts } from "../../browser/src/state/extensions/userScripts";
import { leadUserScripts } from "./hostUserScripts";
import { LINUX_APP_COMMANDS, recordFreshProfile, startAppCommands, startLinuxAppServices, UTILITY_APP_COMMANDS } from "./appServices";
import { linuxCapabilities } from "./hostCapabilities";
import { useExtensions } from "../../browser/src/state/extensions/store";
import { openExtensionFromMenu } from "../../browser/src/state/extensions/bridge";
import { ardiaHost, invokeHost } from "./host";
import { watchTabSwitches } from "./tabSwitchAhead";
import { emitNativeEvent, setSharedCommands } from "./shims/expo-modules-core";
import { configRestoreSession, startConfigFiles } from "../../browser/src/state/config/configFiles";
import { colorRoles } from "../../browser/src/components/ui/tokens";
import { startHostConfig } from "./hostConfig";
import { COMMANDS } from "../../browser/src/state/commands/commandCatalog";
import { opensOnCommandBar } from "./hostSmallWindows";
import { hydrateLaunchSession, linuxSessionShape, startHostPersistence } from "./hostSession";
import { noteWindowOpenedFloating } from "../../browser/src/state/telemetry/windowPlacementCounts";
import { consentAtLaunch } from "../../browser/src/state/telemetry/choice";
import { noteSessionFromOtherShell } from "../../browser/src/state/telemetry/sessionWrites";
import { sessionRowLists } from "../../browser/src/state/session/savedShapes";
import { startHostData } from "./hostData";
import { startHostDownloads } from "./hostDownloads";
import { startHostTabLifecycle } from "./hostTabLifecycle";
import { startLinuxTabPolicies, TAB_POLICY_CHANNEL, watchHostInputActivity } from "./hostPolicies";
import { watchInstallPromptCancellations } from "./extensionPrompts";
import { watchUnclaimedTabs } from "./unclaimedTabs";
import { listenForOpenUrls } from "./openUrls";
import { followExtensionChanges, settingsShowsExtensions } from "./utilityExtensions";
import { refreshExtensionsAfterChange } from "../../browser/src/state/extensions/actions";
import { provideNativeModuleProvider, requireNativeModule } from "./shims/expo-modules-core";
import { setHostPageHooks } from "./hostPageHooks";
import { applyHostPageTheme, forgetDepartedPage, resetHostPage } from "./hostPageLifecycle";
import { setPopupDismissal } from "./popupDismissal";
import { MenuHost } from "./menus";
import { startPopoverEscape } from "./popoverEscape";
import { startEditTargets } from "./editTargets";
import { startNotificationResponses } from "../../browser/src/state/app/notificationResponses";
import { inputRegions, startShellAbove, startUtilityShellGlass } from "./shellAbove";
import { InWindowPlayer } from "./InWindowPlayer";
import { startUpdates } from "@platform/updater";
import { noticeLaunch } from "@platform/launchNotice";
import { hostSwitchesFetch, killSwitchesAvailable } from "./hostKillSwitches";
import { startKillSwitches } from "../../browser/src/platform/killSwitchesLaunch";
import { noteSwitchRefresh } from "../../browser/src/state/telemetry/updateCounts";
import { watchWindowDecorations } from "./windowDecorations";
import { countLoginPasswordChecks } from "./reauthCounts";
import { startPipPlayer } from "./pipPlayer";
import { startLinuxShortcuts } from "./shortcutsRuntime";
import { linuxWindowMenu } from "./linuxWindowMenu";
import { TrafficLights } from "./TrafficLights";
import { startWindowButtonStyle } from "../../browser/src/state/windows/windowButtons";
import { followButtonLayout } from "@platform/buttonLayout";
import { followMaximizeButtonState } from "./maximizeButtonState";
import { followWindowMaximized } from "./windowMaximized";
import { createUtilitySessionSnapshot, initialLinuxLaunch, isLinuxUtility, setSessionDeparture, setSessionFlush } from "./session";
import { noteRestoredWindows } from "../../browser/src/state/sidebar/launchRows";
import { startUtility } from "./utility";
import { announceShellPainted } from "./shellPainted";
import { watchActiveProfile } from "./hostWindowProfiles";
import { announceCommandsReady, announceTypeaheadReady, windowExpectsField } from "./typeahead";
import { linuxSyncHooks, startLinuxSync } from "./syncEngine";
import { settingsSyncWaitsAtDesktopLaunch } from "./syncLaunch";
import { refreshDocument } from "./shims/shellBase";
import { linuxLiveHooks } from "./liveHooks";
import { connectCalendar, refreshCalendar, setCalendarHidden, useCalendar } from "../../browser/src/state/live/calendar";
import { useMeetingAlert } from "../../browser/src/state/live/alerts";
import { linuxTelemetryHooks, reportRecoverableRender, reportUncaughtRender, startHostTelemetry, whenTelemetryLeads } from "./hostTelemetry";
import { launchCommitted } from "../../browser/src/state/telemetry/journeys";
import { markFirstWindow } from "../../browser/src/state/telemetry/track";
import { probeKeyringAfterLaunch } from "./keyringProbe";
import { deliverLaunch, measureLaunch } from "./launchMeasure";
import { setDownloadFlowOwner } from "../../browser/src/state/telemetry/downloadWork";
import { consentToken, stillValid } from "../../browser/src/state/telemetry/choice";
import type { LeaderLocks } from "./telemetryLeader";
import { liveOf } from "../../browser/src/state/tabs/tabLive";
import { startNativeMenuBar, startUtilityMenuBar } from "./nativeMenuBarHost";

Object.assign(globalThis, { ardiaLinux: { store: useBrowser, pages: usePages, emitCommand, extensions: useExtensions, openExtension: openExtensionFromMenu, webviews, media: useMedia, lifecycle: { state: useLifecycle }, sync: linuxSyncHooks, live: linuxLiveHooks, tabLive: { liveOf }, toolbar: useToolbarAutoHide, windowMenu: linuxWindowMenu, selection: { state: usePageSelection, jump: jumpToSelection, copyQuoteLink: copyLinkToSelection, replaceInField }, calendar: { state: useCalendar, connect: connectCalendar, refresh: refreshCalendar, hide: setCalendarHidden, alert: useMeetingAlert }, inputRegions, telemetry: linuxTelemetryHooks } });
setHostPageHooks({ reset: resetHostPage, applyTheme: applyHostPageTheme, depart: (tabId) => ardiaHost && forgetDepartedPage(tabId, ardiaHost.bootstrap.windowId) });
setWindowCloseDecider(decideLinuxWindowClose);

function FirstWindowCommitted({ typeahead, launch }: { typeahead: boolean; launch: boolean }) {
  const [renderedAt] = useState(Date.now);
  useLayoutEffect(() => {
    if (!launch) return;
    const committedAt = Date.now();
    const consent = consentToken();
    measureLaunch(committedAt, (contentAt, usableAt) =>
      whenTelemetryLeads(() => {
        if (ardiaHost) probeKeyringAfterLaunch(ardiaHost);
        deliverLaunch({ committedAt, contentAt, usableAt, consent }, Date.now(), stillValid, (sample) => {
          launchCommitted(sample.consent, renderedAt, sample.committedAt, sample.contentAt, sample.usableAt);
          markFirstWindow(sample.committedAt);
        });
      }),
    );
  }, []);
  useEffect(() => {
    firstWindowCommitted();
    if (ardiaHost) void announceShellPainted(ardiaHost);
    if (typeahead && ardiaHost) {
      announceCommandsReady(ardiaHost);
      announceTypeaheadReady(ardiaHost, { expectsField: () => windowExpectsField(useBrowser.getState(), ardiaHost!.bootstrap.windowId, useOnboarding.getState().windowId) });
    }
  }, [typeahead]);
  return null;
}

async function start() {
  setSharedCommands((command) => Object.hasOwn(COMMANDS, command) && !LINUX_APP_COMMANDS.has(command));
  if (!ardiaHost) throw new Error("The Linux desktop UI requires an Ardia native host");
  setNewTabPrewarm(false);
  const { windowId, profileId } = ardiaHost.bootstrap;
  const utility = isLinuxUtility(windowId);
  const configReady = startHostConfig(ardiaHost, () => emitNativeEvent("ArdiaConfig", "onChange", {}));
  const stored = ardiaHost.bootstrap.session ?? await invokeHost<HydrateData | null>("session.read", {});
  await configReady;
  const saved = stored ? linuxSessionShape(stored) : stored;
  const launch = ardiaHost.bootstrap.startup !== false;
  const restoreSession = launch ? configRestoreSession() : undefined;
  setStoreBatching(unstable_batchedUpdates);
  const { initial, restored } = initialLinuxLaunch(ardiaHost, saved?.settings && restoreSession !== undefined ? { ...saved, settings: { ...saved.settings, restoreSession } } : saved);
  const retiredDefaultsWaitForSync = await settingsSyncWaitsAtDesktopLaunch(refreshDocument);
  hydrateLaunchSession(saved, initial, { retiredDefaultsWaitForSync });
  noteRestoredWindows(restored);
  followButtonLayout(ardiaHost);
  startWindowButtonStyle();
  followWindowMaximized(ardiaHost, windowId);
  followMaximizeButtonState(ardiaHost, windowId);
  startConfigFiles(colorRoles, launch);
  startHostTelemetry({ host: ardiaHost, candidate: !utility, locks: navigator.locks as unknown as LeaderLocks });
  setDownloadFlowOwner(linuxTelemetryHooks.leading);
  if (ardiaHost.bootstrap.openedFloating) noteWindowOpenedFloating(!utility, consentAtLaunch());
  if (ardiaHost.bootstrap.startup === true && stored && sessionRowLists(stored)) noteSessionFromOtherShell(consentAtLaunch());
  countLoginPasswordChecks(linuxTelemetryHooks.leading);
  watchWindowDecorations(ardiaHost, windowId);
  const capabilities = linuxCapabilities(ardiaHost);
  if (capabilities.cliControl) startProgramControl();
  await startLinuxShortcuts(ardiaHost);
  if (utility) {
    const persistence = startHostPersistence(ardiaHost, useBrowser, stored ?? {}, createUtilitySessionSnapshot(useBrowser.getState(), saved ?? {}));
    setSessionFlush(persistence.flush);
    startHostData();
    startAppCommands(windowId, capabilities, undefined, UTILITY_APP_COMMANDS);
    startLinuxSync({ host: ardiaHost, candidate: false });
    followExtensionChanges(ardiaHost, settingsShowsExtensions, refreshExtensionsAfterChange);
    startUtilityMenuBar(ardiaHost, windowId);
    startUtilityShellGlass(ardiaHost);
    await startUtility(ardiaHost);
  } else {
    if (useBrowser.getState().windows[windowId]?.kind === "main") useBrowser.setState(adoptParkedPins(useBrowser.getState(), windowId, profileId));
    if (opensOnCommandBar(useBrowser.getState(), windowId)) useBrowser.getState().openPanel(windowId, "");
    watchActiveProfile(ardiaHost, useBrowser);
    startHostData();
    startHostTabLifecycle(ardiaHost, useBrowser);
    startShellAbove(ardiaHost);
    onPageCovered((tabId) => linuxTelemetryHooks.leading() && noteToolbarPageHidden(useToolbarAutoHide.getState().peek[tabId] ? "peek" : toolbarMoving(tabId) ? "motion" : null));
    onPageCovered(() => peekShown(windowId) && noteSidebarPeekPageHidden());
    startPipPlayer(ardiaHost);
    watchTabSwitches(useBrowser);
    setPopupDismissal({ popup: () => useExtensions.getState().popup, windowOf: (tabId) => useBrowser.getState().tabs[tabId]?.windowId, close: () => useExtensions.setState({ popup: null }) });
    startEditTargets();
    startNotificationResponses();
    startPopoverEscape({ target: window, windowId, menuShown, activeElement: () => document.activeElement, unclaimed: () => emitAppEvent({ type: "unclaimedEscape", windowId }) });
    const persistence = startHostPersistence(ardiaHost, useBrowser, stored ?? {});
    setSessionFlush(persistence.flush);
    setSessionDeparture(persistence);
    if (!saved) await recordFreshProfile();
    await persistence.flush();
    startTabPages();
    startReader();
    startNativeSync();
    startNativeMenuBar(ardiaHost, windowId);
    listenForOpenUrls(ardiaHost);
    startHostDownloads(ardiaHost, useBrowser);
    watchUnclaimedTabs(ardiaHost, useBrowser);
    startLinuxTabPolicies({
      target: window, provide: provideNativeModuleProvider, startLifecycle: startTabLifecycle, startTrim: startMemoryTrim,
      startProfileUnloading: capabilities.unloadIdleProfiles ? startProfileUnloading : undefined,
      windowId, locks: navigator.locks, channel: new BroadcastChannel(TAB_POLICY_CHANNEL), privateWindow: !!ardiaHost.bootstrap.privateWindow,
      activity: (listener) => watchHostInputActivity(requireNativeModule("ArdiaEngine"), listener),
    });
    watchInstallPromptCancellations(ardiaHost, useExtensions);
    startLinuxSync({ host: ardiaHost, candidate: true, locks: navigator.locks });
    if (capabilities.cliControl && !ardiaHost.bootstrap.privateWindow) afterFirstWindow(startAutomation);
    if (capabilities.userScripts && !ardiaHost.bootstrap.privateWindow) afterFirstWindow(() => leadUserScripts({ locks: navigator.locks, start: startUserScripts }));
    if (killSwitchesAvailable(ardiaHost)) startKillSwitches(hostSwitchesFetch(ardiaHost, fetch.bind(globalThis)), noteSwitchRefresh);
    startUpdates(ardiaHost, navigator.locks);
    const services = startLinuxAppServices({
      host: ardiaHost,
      windowId,
      savedSession: !!saved,
      capabilities,
      locks: navigator.locks,
      marks: sessionStorage,
    });
    void noticeLaunch(ardiaHost, windowId, services.launch);
  }
  createRoot(document.getElementById("root")!, { onUncaughtError: (error) => { reportUncaughtRender(error); console.error("[ardia linux] crashed", error); }, onRecoverableError: (error) => { reportRecoverableRender(error); console.warn("[ardia linux] recovered", error); } }).render(
    <div className={`ardia-desktop host ardia-linux${utility ? " utility" : ""}`} data-ardia-linux-window={windowId}>
      <div className="ardia-window">
        {!utility && <InWindowPlayer windowId={windowId} />}
        <WindowRoot windowId={windowId} />
        <TrafficLights windowId={windowId} />
      </div>
      <MenuHost />
      <FirstWindowCommitted typeahead={!utility} launch={!utility && launch} />
    </div>,
  );
}

export const startShell = () => start();
