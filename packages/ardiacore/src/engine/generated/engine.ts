import type { BatterySaverMode, BatterySaverState, ChildProcessCpu, CliControlStatus, CliTabTarget, CursorRestore, EngineComponent, EngineInfo, EngineTask, HoverLostEpisode, MemorySaverRequest, MemorySaverState, PopupProtectedMedia, PressLoopLongReport, SystemState, WindowUnpaintedRecord } from "../../engineDomain";
import type { Done } from "../wire";

export type EngineCalls = {
  "engine.info": [{}, EngineInfo];
  "engine.components": [{}, EngineComponent[]];
  "engine.tasks": [{}, EngineTask[]];
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
  "engine.setCliHeldTabs": [{ tabs: { tabId: string; until: number }[] }, { kept: number; marked: string[] }];
  "engine.cliOwnsTab": [{ tabId: string }, { owned: boolean; shown: boolean }];
  "engine.cliMoveOffscreen": [{ tabId: string }, { ok: boolean; reason?: string }];
  "engine.cliCloseOffscreenTabs": [{}, Done];
};

export type EngineEvents = {
  "engine.systemState": SystemState;
  "engine.cliControl": CliControlStatus;
  "engine.hoverLost": HoverLostEpisode;
  "engine.popupProtectedMedia": PopupProtectedMedia;
  "engine.devToolsKeyKept": { epoch: string };
  "engine.cursorRestored": CursorRestore;
  "engine.windowUnpainted": WindowUnpaintedRecord;
  "engine.pressLoopLong": PressLoopLongReport;
};
