import { useBrowser, type BrowserState } from "../browser/store";

const CONTROL_KEY = "cliControl";

export const programControlOn = (s: Pick<BrowserState, "settings">) => s.settings.cliControl;

export const setProgramControl = (on: boolean) => useBrowser.getState().updateSettings({ cliControl: on });

export const setControlFromSettings = (on: boolean) => setProgramControl(on);

function userChoseControl(): boolean {
  const { settingsMeta } = useBrowser.getState();
  return settingsMeta.chosen.includes(CONTROL_KEY) && !settingsMeta.inferred.includes(CONTROL_KEY);
}

export const userTurnedControlOff = () => !programControlOn(useBrowser.getState()) && userChoseControl();

export const useControlTurnedOff = () =>
  useBrowser((s) => !s.settings.cliControl && s.settingsMeta.chosen.includes(CONTROL_KEY) && !s.settingsMeta.inferred.includes(CONTROL_KEY));

export const showControlPill = (s: Pick<BrowserState, "settings">) => s.settings.showCliPill;

export const compactControlPill = (s: Pick<BrowserState, "settings">) => s.settings.compactCliPill;
