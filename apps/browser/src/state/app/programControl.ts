import { controlStatus, onControlChanged, setControl, setControlActiveTab, type ControlStatus } from "../../platform/control";
import { create } from "zustand";
import { useBrowser, type BrowserState } from "../browser/store";
import { hasPage } from "../tabs/pageSession";
import { shownPageId } from "../peek/peek";
import { isTabReady, pageOf, usePages } from "../tabs/pageState";
import { isInternalTab } from "../pages/urls";
import { errorText } from "../../lib/errors";
import { focusedWindowOf } from "../windows/ui";
import { noteCliPillShown } from "../telemetry/cliCounts";
import { noteDragsEnded } from "../telemetry/stuckDrags";
import { consentToken, type ConsentToken } from "../telemetry/client";
import type { ControlCaller } from "./controlCaller";
import { noteCliConnections } from "../automation/offscreen";
import { compactControlPill, programControlOn, setProgramControl } from "./programControlSetting";
import { startCommandInstall } from "./linuxCommandInstall";

const INDICATOR_HOLD_MS = 3000;


export const useControlServer = create<{ server: ControlStatus | null }>()(() => ({ server: null }));

export const useControlIndicator = create<{ shown: boolean; caller: ControlCaller | null }>()(() => ({ shown: false, caller: null }));

let indicatorHide: ReturnType<typeof setTimeout> | null = null;
let socketRuns = 0;
let socketServing = false;
let indicatorStep = 0;
let callerStep = 0;
let hiddenStep = 0;

function showIndicator(shown: boolean) {
  if (!shown) hiddenStep = ++indicatorStep;
  else noteCliPillShown(compactControlPill(useBrowser.getState()));
  const caller = shown && callerStep < hiddenStep ? null : useControlIndicator.getState().caller;
  useControlIndicator.setState({ shown, caller });
}

export function noteControlCaller(caller: ControlCaller) {
  callerStep = ++indicatorStep;
  const current = useControlIndicator.getState().caller;
  if (current?.name !== caller.name || current.app !== caller.app) useControlIndicator.setState({ caller });
}

function updateIndicator({ server }: { server: ControlStatus | null }) {
  const cdpOn = server?.state === "on";
  noteCliConnections(cdpOn ? server.connections : 0);
  const on = cdpOn || socketServing;
  const connected = on && (cdpOn ? server.connections : 0) + socketRuns > 0;
  if (connected || !on) {
    if (indicatorHide) clearTimeout(indicatorHide);
    indicatorHide = null;
    if (useControlIndicator.getState().shown !== connected) showIndicator(connected);
    return;
  }
  if (!useControlIndicator.getState().shown || indicatorHide) return;
  indicatorHide = setTimeout(() => {
    indicatorHide = null;
    showIndicator(false);
  }, INDICATOR_HOLD_MS);
}

useControlServer.subscribe(updateIndicator);

export function noteSocketRun(delta: 1 | -1) {
  socketRuns = Math.max(0, socketRuns + delta);
  updateIndicator(useControlServer.getState());
}

export function noteSocketServing(serving: boolean) {
  socketServing = serving;
  updateIndicator(useControlServer.getState());
}

let sentActive: string | null | undefined;

function shownReadyTab(s: BrowserState): string | null {
  const windowId = focusedWindowOf(s);
  const id = windowId ? shownPageId(s, windowId) : undefined;
  const tab = id ? s.tabs[id] : undefined;
  if (!id || !tab?.url || pageOf(id).newTabShown || !hasPage(tab) || isInternalTab(tab)) return null;
  return isTabReady(id) ? id : null;
}

function pushActiveTab() {
  const state = useControlServer.getState().server?.state;
  if (state !== "on" && state !== "starting") {
    sentActive = undefined;
    return;
  }
  const active = shownReadyTab(useBrowser.getState());
  if (active === sentActive) return;
  sentActive = active;
  const consent = consentToken();
  void setControlActiveTab(active).then((status) => noteDragsEnded(status.dragsEnded, consent), () => {});
}

export function noteTabReady(tabId: string) {
  if (sentActive === tabId) sentActive = undefined;
  pushActiveTab();
}

export const stopProgramControl = () => setProgramControl(false);

let started = false;

export function startProgramControl() {
  if (started) return;
  started = true;
  let latest = 0;
  let inFlight = 0;
  let newest = 0;
  const apply = (server: ControlStatus, mayReconcile: boolean, consent?: ConsentToken | null) => {
    noteDragsEnded(server.dragsEnded, consent);
    const generation = server.state === "external" ? newest : server.generation;
    if (generation < newest) return;
    newest = generation;
    useControlServer.setState({ server });
    const stoppedItself = server.state === "off" && !!server.reason;
    if (mayReconcile && stoppedItself && programControlOn(useBrowser.getState())) setProgramControl(false);
  };
  onControlChanged((server) => apply(server, inFlight === 0));
  let applied: boolean | null = null;
  const sync = () => {
    const on = programControlOn(useBrowser.getState());
    if (on === applied) return;
    const first = applied === null;
    applied = on;
    const request = ++latest;
    const consent = consentToken();
    inFlight++;
    const settle = (server: ControlStatus) => {
      inFlight--;
      if (request === latest) apply(server, true, consent);
    };
    const call = first && !on ? controlStatus() : setControl(on);
    void call.then(settle, (e: unknown) => settle({ state: "off", connections: 0, generation: newest, file: "", reason: errorText(e) }));
  };
  sync();
  useBrowser.subscribe(() => {
    sync();
    pushActiveTab();
  });
  useControlServer.subscribe(pushActiveTab);
  usePages.subscribe(pushActiveTab);
  startCommandInstall();
}

if (__DEV__) (globalThis as { acControl?: unknown }).acControl = { server: useControlServer, indicator: useControlIndicator };
