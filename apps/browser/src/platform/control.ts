import { call, on, type CliControlStatus } from "@ardia/ardiacore";

export type ControlStatus = CliControlStatus;

export const setControl = (enabled: boolean) => call("engine.setCliControl", { on: enabled });
export const setControlActiveTab = (tabId: string | null) => call("engine.setCliActiveTab", { tabId });
export const controlStatus = () => call("engine.cliControlStatus");
export const controlTabTargets = (tabIds: string[]) => call("engine.cliTabTargets", { tabIds });
export const controlOwnsTab = (tabId: string) => call("engine.cliOwnsTab", { tabId });
export const controlMoveOffscreen = (tabId: string) => call("engine.cliMoveOffscreen", { tabId });
export const controlCloseOffscreenTabs = () => call("engine.cliCloseOffscreenTabs");
export const mintPluginCredential = (tabId: string) => call("engine.cliPluginCredential", { tabId });
export const revokePluginCredential = (id: string) => call("engine.cliPluginCredential", { revoke: id });
export const holdPluginTabVisible = (id: string, tabId: string, visible: boolean) => call("engine.cliPluginCredential", { id, tabId, visible });
export const actDocument = (tabId: string, credential: string) => call("engine.cliActDocument", { tabId, credential });
export const actLease = (tabId: string, credential: string, document: number) => call("engine.cliActLease", { tabId, credential, document });
export const actRelease = (lease: number) => call("engine.cliActRelease", { lease });
export const onControlChanged = (listener: (status: ControlStatus) => void) => on("engine.cliControl", listener);
