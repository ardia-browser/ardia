import { useBrowser, type BrowserState } from "../browser/store";
import type { ConsentToken } from "../telemetry/choice";
import { noteControlRestoreTry, type ControlRestoreCause } from "../telemetry/cliCounts";

const CONTROL_KEY = "cliControl";

type ControlState = Pick<BrowserState, "settings" | "settingsMeta">;

export const programControlOn = (s: Pick<BrowserState, "settings">) => s.settings.cliControl;

export const setControlByUser = (on: boolean) => useBrowser.getState().updateSettings({ cliControl: on });

export const setControlByApp = (on: boolean) => useBrowser.getState().updateSettings({ cliControl: on }, { inferred: true });

const offByUser = (s: ControlState) => !s.settings.cliControl && s.settingsMeta.chosen.includes(CONTROL_KEY) && !s.settingsMeta.inferred.includes(CONTROL_KEY);

const offByApp = (s: ControlState) => !s.settings.cliControl && s.settingsMeta.inferred.includes(CONTROL_KEY);

export const userTurnedControlOff = () => offByUser(useBrowser.getState());

export const controlStoppedItself = () => offByApp(useBrowser.getState());

export const useControlTurnedOff = () => useBrowser(offByUser);

type PendingRestore = { consent: ConsentToken | null };

let pendingRestore: PendingRestore | null = null;

export function takeControlRestore(): PendingRestore | null {
  const pending = pendingRestore;
  pendingRestore = null;
  return pending;
}

function noteRestore(cause: ControlRestoreCause, consent: ConsentToken | null) {
  if (!controlStoppedItself()) return;
  pendingRestore = { consent };
  noteControlRestoreTry(cause, consent);
}

export function controlOnByApproval(consent: ConsentToken | null): boolean {
  if (programControlOn(useBrowser.getState()) || userTurnedControlOff()) return false;
  noteRestore("approval", consent);
  return true;
}

export function restoreControlAtLaunch(consent: ConsentToken | null) {
  if (!controlStoppedItself()) return;
  noteRestore("launch", consent);
  setControlByApp(true);
}

export const showControlPill = (s: Pick<BrowserState, "settings">) => s.settings.showCliPill;

export const compactControlPill = (s: Pick<BrowserState, "settings">) => s.settings.compactCliPill;
