import type { BatterySaverMode, BatterySaverState, ChildProcessCpu, CliClick, CliConsoleDelta, CliControlStatus, CliDevToolsEvent, CliDevToolsOpened, CliDevToolsReply, CliHitTest, CliScreenshot, CliSettle, CliSnapshot, CliTabTarget, CursorRestore, EngineComponent, EngineInfo, EngineTask, HoverLostEpisode, MemorySaverRequest, MemorySaverState, PopupProtectedMedia, PressLoopLongReport, SystemState, WindowUnpaintedRecord } from "../../engineDomain";
import type { Done } from "../wire";

export type EngineCalls = {
  "engine.info": [{}, EngineInfo];
  "engine.components": [{}, EngineComponent[]];
  "engine.tasks": [{}, EngineTask[]];
  "engine.nativeMessagingHosts": [{}, { found: number; registered: number; keptTheirs: number; missing: number; unusable: number }];
  "engine.childProcessCpu": [{}, ChildProcessCpu[]];
  "engine.beginTracing": [{}, boolean];
  "engine.endTracing": [{ keep: boolean }, string | null];
  "engine.isTracing": [{}, boolean];
  "engine.systemState": [{}, SystemState];
  "engine.batterySaver": [{ mode: BatterySaverMode }, BatterySaverState];
  "engine.memorySaver": [MemorySaverRequest, MemorySaverState];
  "engine.validateKeepActiveSite": [{ site: string }, { valid: boolean }];
  "engine.trimMemory": [{}, { ok: boolean }];
  "engine.openTaskManager": [{}, { ok: boolean }];
  "engine.cliControlStatus": [{}, CliControlStatus];
  "engine.setCliControl": [{ on: boolean }, CliControlStatus];
  "engine.setCliActiveTab": [{ tabId: string | null }, CliControlStatus];
  "engine.cliTabTargets": [{ tabIds: string[] }, Record<string, CliTabTarget>];
  "engine.setCliHeldTabs": [{ tabs: { tabId: string; until: number; live?: boolean }[] }, { kept: number; marked: string[] }];
  "engine.cliOwnsTab": [{ tabId: string }, { owned: boolean; shown: boolean }];
  "engine.cliConsoleDelta": [{ tabId: string; after?: number; generation?: number; limit?: number }, CliConsoleDelta];
  "engine.cliDevToolsOpen": [{ tabId: string; owner: string; scope: "full" | "inspect" }, CliDevToolsOpened];
  "engine.cliDevToolsSend": [{ session: number; owner: string; method: string; params?: Record<string, unknown>; sessionId?: string; timeoutMs?: number }, CliDevToolsReply];
  "engine.cliDevToolsClose": [{ session: number; owner: string }, { closed: boolean }];
  "engine.cliCancel": [{ owner?: string; all?: boolean }, { cancelled: number }];
  "engine.cliSnapshot": [{ tabId: string; owner?: string; maxRefs?: number; maxTextBytes?: number; interactiveOnly?: boolean; wholePage?: boolean; occlusion?: boolean }, CliSnapshot];
  "engine.cliWaitSettled": [{ tabId: string; owner?: string; timeoutMs?: number; quietMs?: number; longRequestMs?: number; maxInflight?: number; idle?: boolean; frame?: boolean }, CliSettle];
  "engine.cliHitTest": [{ tabId: string; owner?: string; ref?: string; x?: number; y?: number }, CliHitTest];
  "engine.cliClick": [{ tabId: string; owner?: string; ref?: string; x?: number; y?: number; force?: boolean; button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: number }, CliClick];
  "engine.cliScreenshot": [{ tabId: string; owner?: string; format?: "png" | "jpeg"; quality?: number; clip?: { x: number; y: number; width: number; height: number }; scale?: number }, CliScreenshot];
  "engine.cliMoveOffscreen": [{ tabId: string }, { ok: boolean; reason?: string }];
  "engine.cliCloseOffscreenTabs": [{}, Done];
};

export type EngineEvents = {
  "engine.systemState": SystemState;
  "engine.cliControl": CliControlStatus;
  "engine.cliDevTools": CliDevToolsEvent;
  "engine.hoverLost": HoverLostEpisode;
  "engine.popupProtectedMedia": PopupProtectedMedia;
  "engine.devToolsKeyKept": { epoch: string };
  "engine.cursorRestored": CursorRestore;
  "engine.windowUnpainted": WindowUnpaintedRecord;
  "engine.pressLoopLong": PressLoopLongReport;
};
