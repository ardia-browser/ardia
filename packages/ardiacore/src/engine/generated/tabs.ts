import type { LinkRoute, TabDiagnosticsRead, TabEngineRefusal, TabInputArgs, TabInputDone, TabInputPrimed, TabStripCommand, TabStripTransaction } from "../../tabs";

export type TabsCalls = {
  "tabs.routeLinkTabs": [{ urls: string[] }, LinkRoute];
  "tabs.stripCommand": [{ id: number; command: TabStripCommand }, null];
  "tabs.strips": [{}, TabStripTransaction];
  "tabs.lastTabPolicy": [{}, { closesWindow: boolean }];
  "tabs.diagnostics": [{ tabId: string; since?: number; clearBefore?: number }, TabDiagnosticsRead | TabEngineRefusal];
  "tabs.input": [TabInputArgs, TabInputDone | TabInputPrimed | TabEngineRefusal];
  "tabs.reportCommits": [{ on: boolean }, null];
  "tabs.devBrowserId": [{ tabId: string }, number];
  "tabs.devEvents": [{ tabId: string }, { name: string; payload: unknown }[]];
  "tabs.devWindowNumber": [{ tabId: string }, number];
  "tabs.devFocusPage": [{ tabId: string }, boolean];
  "tabs.devPagePhase": [{ tabId: string }, "waiting" | "creating" | "attached" | "closing" | null];
  "tabs.devClosePage": [{ tabId: string }, boolean];
  "tabs.devPictureInPicture": [{}, unknown[]];
  "tabs.devPictureInPictureAction": [{ action: string }, string];
  "tabs.devPostPeekMouseUp": [{ keys: string; tabId: string }, boolean];
  "tabs.devScrollZoom": [{ steps: Record<string, unknown>[]; tabId?: string }, number[]];
};

export type TabsEvents = {
  "tabs.strips": TabStripTransaction;
};
