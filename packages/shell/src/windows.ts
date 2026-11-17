import type { EventSubscription } from "expo-modules-core";

export type Rect4 = [number, number, number, number];

export const POPUP_WINDOW_PREFIX = "popup:";

export const isPopupWindowId = (windowId: string | null | undefined) => typeof windowId === "string" && windowId.startsWith(POPUP_WINDOW_PREFIX);

export type CaptionRegion = readonly [left: number, top: number, rightInsetOrNegativeWidth: number, height: number];

export type WindowControlsNative = {
  minimizeWindow(windowId: string): Promise<void>;
  toggleMaximizeWindow(windowId: string): Promise<void>;
  setCaptionRegions(windowId: string, regions: readonly CaptionRegion[]): Promise<void>;
};

export type WindowEvent =
  | { type: "focus"; id: string; fromPage?: boolean }
  | { type: "close"; id: string }
  | { type: "frame"; id: string; frame: [number, number, number, number]; restored?: [number, number, number, number]; fitted?: boolean }
  | { type: "fullScreen"; id: string; on: boolean; display?: string }
  | { type: "maximized"; id: string; on: boolean }
  | { type: "sidebarEdge"; id: string; over: boolean; point: [number, number]; screenEdge?: "stopped" | "passed" }
  | { type: "closeRequest"; id: string };

export type OpenWindowOptions = {
  frame?: [number, number, number, number] | null;
  display?: string;
  incognito?: boolean;
  title?: string;
  focus?: boolean;
  kind?: "browser" | "small" | "settings" | "import" | "popup";
  profile?: string;
  size?: [number, number];
  behind?: string;
  chromeWindow?: string;
  claim?: string;
  pointer?: [number, number];
  returnTo?: string;
  animated?: boolean;
  maximized?: boolean;
};

export type DragPreviewShape = "hidden" | "pill" | "card";

export type WindowsNative = {
  windowCornerRadius(): number;
  addListener(name: "onWindowEvent", listener: (e: WindowEvent) => void): EventSubscription;
  openWindow(id: string, options: OpenWindowOptions): Promise<void>;
  closeWindow(id: string): Promise<void>;
  animateWindowClose(id: string, after: string | null): Promise<void>;
  focusWindow(id: string): Promise<void>;
  restoreFullScreen(ids: string[], focus: string | null): Promise<void>;
  setTrafficLightsCenter(id: string, center: [number, number] | null, trailing: boolean): Promise<void>;
  watchSidebarEdge(id: string, on: boolean, hold: number, right: boolean, whilePressed: boolean): Promise<void>;
  dragPreviewBegin(windowId: string, chip: Rect4, grab: [number, number]): Promise<void>;
  dragPreviewPage(base64: string, frame: Rect4): Promise<void>;
  dragPreviewUpdate(shape: DragPreviewShape, point: [number, number]): Promise<void>;
  dragPreviewCancel(): Promise<void>;
  dragPreviewPlaceholder(title: string, favicon: string | null): Promise<void>;
  dragPreviewEnd(windowId: string | null, frame: Rect4 | null): Promise<void>;
  raiseView(tag: number, levels: number, raised: boolean): Promise<void>;
  windowFrame(id: string): Promise<Rect4 | null>;
  frameCornerRadius(id: string): Promise<number>;
  setWindowTitle(id: string, title: string): Promise<void>;
  windowIds(): Promise<string[]>;
  replyToTerminate(ok: boolean): Promise<void>;
};
