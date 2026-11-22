import { call, on, type CliControlStatus } from "@ardia/ardiacore";

export type ControlStatus = CliControlStatus;

export const setControl = (enabled: boolean) => call("engine.setCliControl", { on: enabled });
export const setControlActiveTab = (tabId: string | null) => call("engine.setCliActiveTab", { tabId });
export const controlStatus = () => call("engine.cliControlStatus");
export const controlTabTargets = (tabIds: string[]) => call("engine.cliTabTargets", { tabIds });
export const controlOwnsTab = (tabId: string) => call("engine.cliOwnsTab", { tabId });
export const controlMoveOffscreen = (tabId: string) => call("engine.cliMoveOffscreen", { tabId });
export const controlCloseOffscreenTabs = () => call("engine.cliCloseOffscreenTabs");
export const onControlChanged = (listener: (status: ControlStatus) => void) => on("engine.cliControl", listener);
