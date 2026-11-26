import { call, on, type CliControlStatus, type CliDevToolsEvent, type TabInputArgs } from "@ardia/ardiacore";

export type { TabConsoleEntry, TabDiagnosticsRead, TabEngineRefusal, TabInputAction, TabInputArgs, TabInputDone, TabInputModifier, TabInputPrimed, TabNetworkEntry } from "@ardia/ardiacore";

export type ControlStatus = CliControlStatus;

export const setControl = (enabled: boolean) => call("engine.setCliControl", { on: enabled });
export const setControlActiveTab = (tabId: string | null) => call("engine.setCliActiveTab", { tabId });
export const controlStatus = () => call("engine.cliControlStatus");
export const controlTabTargets = (tabIds: string[]) => call("engine.cliTabTargets", { tabIds });
export const setControlHeldTabs = (tabs: { tabId: string; until: number; live: boolean }[]) => call("engine.setCliHeldTabs", { tabs });
export const controlConsoleDelta = (tabId: string, read: { after?: number; generation?: number; limit?: number }) =>
  call("engine.cliConsoleDelta", { tabId, ...Object.fromEntries(Object.entries(read).filter(([, value]) => value !== undefined)) });
export const controlOwnsTab = (tabId: string) => call("engine.cliOwnsTab", { tabId });
export const controlMoveOffscreen = (tabId: string) => call("engine.cliMoveOffscreen", { tabId });
export const controlCloseOffscreenTabs = () => call("engine.cliCloseOffscreenTabs");
const defined = <T extends Record<string, unknown>>(fields: T) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

export type ControlDevToolsScope = "full" | "inspect";
export const controlDevToolsOpen = (tabId: string, owner: string, scope: ControlDevToolsScope) => call("engine.cliDevToolsOpen", { tabId, owner, scope });
export const controlDevToolsSend = (send: { session: number; owner: string; method: string; params?: Record<string, unknown>; sessionId?: string; timeoutMs?: number }) =>
  call("engine.cliDevToolsSend", defined(send));
export const controlDevToolsClose = (session: number, owner: string) => call("engine.cliDevToolsClose", { session, owner });
export type ControlDevToolsEvent = CliDevToolsEvent;
export const onControlDevTools = (listener: (event: CliDevToolsEvent) => void) => on("engine.cliDevTools", listener);
export const controlCancel = (owner: string) => call("engine.cliCancel", { owner });
export const controlCancelAll = () => call("engine.cliCancel", { all: true });
export const controlSnapshot = (tabId: string, read: { owner?: string; maxRefs?: number; maxTextBytes?: number; interactiveOnly?: boolean; wholePage?: boolean; occlusion?: boolean }) =>
  call("engine.cliSnapshot", defined({ tabId, ...read }));
export const controlWaitSettled = (tabId: string, wait: { owner?: string; timeoutMs?: number; quietMs?: number; longRequestMs?: number; maxInflight?: number; idle?: boolean; frame?: boolean }) =>
  call("engine.cliWaitSettled", defined({ tabId, ...wait }));
export const controlHitTest = (tabId: string, at: { owner?: string; ref?: string; x?: number; y?: number }) => call("engine.cliHitTest", defined({ tabId, ...at }));
export const controlClick = (
  tabId: string,
  at: { owner?: string; ref?: string; x?: number; y?: number; force?: boolean; button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: number },
) => call("engine.cliClick", defined({ tabId, ...at }));
export const controlScreenshot = (tabId: string, shot: { owner?: string; format?: "png" | "jpeg"; quality?: number; clip?: { x: number; y: number; width: number; height: number }; scale?: number }) =>
  call("engine.cliScreenshot", defined({ tabId, ...shot }));
export const controlTabDiagnostics = (tabId: string, since: number, clearBefore?: number) => call("tabs.diagnostics", { tabId, since, ...(clearBefore === undefined ? {} : { clearBefore }) });
export const controlTabInput = (input: TabInputArgs) => call("tabs.input", input);
export const onControlChanged = (listener: (status: ControlStatus) => void) => on("engine.cliControl", listener);
