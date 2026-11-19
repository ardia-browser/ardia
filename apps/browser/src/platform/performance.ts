import { call, inputIdleSeconds, on, type BatterySaverMode, type CursorRestore, type EngineTask, type HoverLostEpisode, type MemorySaverMode, type MemorySaverRequest, type PressLoopLongReport, type PopupProtectedMedia, type SystemState, type WindowUnpaintedRecord } from "@ardia/ardiacore";

export { inputIdleSeconds };
export type { EngineTask, HoverLostEpisode, MemorySaverMode, PressLoopLongReport, PopupProtectedMedia, SystemState, WindowUnpaintedRecord };

export const listTasks = () => call("engine.tasks");
export const systemState = () => call("engine.systemState");
export const onSystemState = (listener: (state: SystemState) => void) => on("engine.systemState", listener);
export const onHoverLost = (listener: (episode: HoverLostEpisode) => void) => on("engine.hoverLost", listener);
export const onPopupProtectedMedia = (listener: (media: PopupProtectedMedia) => void) => on("engine.popupProtectedMedia", listener);
export const onDevToolsKeyKept = (listener: (kept: { epoch: string }) => void) => on("engine.devToolsKeyKept", listener);
export const onPageDropTypesChanged = (listener: (changed: { epoch: string; unregistered: number; reregistered: number }) => void) => on("engine.pageDropTypesChanged", listener);
export const onCursorRestored = (listener: (restore: CursorRestore) => void) => on("engine.cursorRestored", listener);
export const onWindowUnpainted = (listener: (record: WindowUnpaintedRecord) => void) => on("engine.windowUnpainted", listener);
export const onPressLoopLong = (listener: (report: PressLoopLongReport) => void) => on("engine.pressLoopLong", listener);
export const setBatterySaver = (mode: BatterySaverMode) => call("engine.batterySaver", { mode });
export const setMemorySaver = (request: MemorySaverRequest) => call("engine.memorySaver", request);
export const isKeepActiveSiteValid = (site: string) => call("engine.validateKeepActiveSite", { site }).then((reply) => reply.valid);
export const trimEngineMemory = () => call("engine.trimMemory");
export const beginTracing = () => call("engine.beginTracing");
export const endTracing = (keep: boolean) => call("engine.endTracing", { keep });
export const isTracing = () => call("engine.isTracing");
export const openTaskManager = () => call("engine.openTaskManager");
