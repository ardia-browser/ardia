import type { ComponentProps } from "react";
import { call } from "@ardia/ardiacore";
import { isPopupWindowId, nativeModule, type DragPreviewShape, type OpenWindowOptions, type OutsidePressArea, type Rect4, type WindowEvent, type WindowGeometry } from "@ardia/shell";
import { PLATFORM_FEATURES } from "../lib/platformFeatures";

export type { DragPreviewShape, WindowEvent, OpenWindowOptions, WindowGeometry };
export type OutsidePressEvent = Parameters<NonNullable<ComponentProps<typeof OutsidePressArea>["onOutsidePress"]>>[0];
export { isPopupWindowId };

const Windows = nativeModule("ArdiaAppWindows");
let cachedWindowCornerRadius: number | undefined;
export const windowCornerRadius = () => (cachedWindowCornerRadius ??= Windows.windowCornerRadius());
export const drawnWindowCornerRadius = () => Windows.drawnWindowCornerRadius();
export const forgetWindowCornerRadius = () => {
  cachedWindowCornerRadius = undefined;
};

export const openWindow = (id: string, options: OpenWindowOptions = {}) => Windows.openWindow(id, options);
export const closeWindow = (id: string) => Windows.closeWindow(id);
export const animateWindowClose = (id: string, after: string | null = null) => Windows.animateWindowClose(id, after);
export const restoreFullScreen = (ids: string[], focus: string | null) => Windows.restoreFullScreen(ids, focus);
export const focusWindow = (id: string) => Windows.focusWindow(id);
export const setWindowShown = (id: string, shown: boolean, burst = false) => Windows.setWindowShown?.(id, shown, burst);
export const setWindowTitle = (id: string, title: string) => Windows.setWindowTitle(id, title);
export type LightsPlace = readonly [x: number, y: number] | readonly [fromRight: number, y: number, edge: "right"];
export const setTrafficLightsCenter = (id: string, center: LightsPlace | null) =>
  Windows.setTrafficLightsCenter(id, center && [center[0], center[1]], center?.[2] === "right");
export const watchSidebarEdge = (id: string, on: boolean, hold = 0, right = false, whilePressed = false) => void Windows.watchSidebarEdge(id, on, hold, right, whilePressed);
export const windowFrame = (id: string) => Windows.windowFrame(id);
export const frameCornerRadius = (id: string) => Windows.frameCornerRadius(id);
export const windowIds = () => Windows.windowIds();
const geometryCall = <T>(run: () => Promise<T>): Promise<T | null> => (PLATFORM_FEATURES.windowGeometry ? run() : Promise.resolve(null));
export const windowGeometry = (id: string) => geometryCall(() => Windows.windowGeometry(id));
export const setWindowFrame = (id: string, frame: Rect4) => geometryCall(() => Windows.setWindowFrame(id, frame));
export const setWindowZoomed = (id: string, on: boolean) => geometryCall(() => Windows.setWindowZoomed(id, on));
export const setWindowFullScreen = (id: string, on: boolean) => geometryCall(() => Windows.setWindowFullScreen(id, on));
export const onWindowEvent = (listener: (e: WindowEvent) => void) => Windows.addListener("onWindowEvent", listener);
export const replyToTerminate = (ok: boolean) => Windows.replyToTerminate(ok);
export const raiseView = (tag: number | null, levels: number, raised: boolean) => {
  if (tag != null) void Windows.raiseView(tag, levels, raised);
};
export const dragPreview = {
  begin: (windowId: string, chip: Rect4, grab: [number, number]) => void Windows.dragPreviewBegin(windowId, chip, grab),
  page: (base64: string, frame: Rect4) => void Windows.dragPreviewPage(base64, frame),
  update: (shape: DragPreviewShape, point: [number, number]) => void Windows.dragPreviewUpdate(shape, point),
  end: (windowId: string | null = null, frame: Rect4 | null = null) => void Windows.dragPreviewEnd(windowId, frame),
  cancel: () => void Windows.dragPreviewCancel(),
  placeholder: (title: string, favicon: string | null) => void Windows.dragPreviewPlaceholder(title, favicon),
};

export const chromeWindows = () => call("windows.list");
export const devWindowAction = (windowNumber: number, action: string) => call("windows.dev", { window: windowNumber, action });

export const setWindowActivity = (windowId: string, url: string | null, title: string | null) =>
  nativeModule("ArdiaApp").setWindowActivity(windowId, url, title);
