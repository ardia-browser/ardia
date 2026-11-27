import type { EventSubscription } from "expo-modules-core";
import type { AppWindowsNative } from "./generated/native";

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
  | { type: "focus"; id: string; fromPage?: boolean; restored?: boolean; field?: number }
  | { type: "close"; id: string }
  | { type: "frame"; id: string; frame: [number, number, number, number]; restored?: [number, number, number, number]; fitted?: boolean }
  | { type: "fullScreen"; id: string; on: boolean; display?: string }
  | { type: "maximized"; id: string; on: boolean }
  | { type: "sidebarEdge"; id: string; over: boolean; point: [number, number]; screenEdge?: "crossed" | "returned"; overlay?: boolean; heldByMenu?: "app" | "system" }
  | { type: "closeRequest"; id: string };

export type OpenWindowOptions = {
  frame?: [number, number, number, number] | null;
  display?: string;
  incognito?: boolean;
  title?: string;
  focus?: boolean;
  kind?: "browser" | "small" | "settings" | "import" | "popup" | "intro";
  profile?: string;
  size?: [number, number];
  behind?: string;
  cover?: string;
  chromeWindow?: string;
  claim?: string;
  pointer?: [number, number];
  returnTo?: string;
  animated?: boolean;
  maximized?: boolean;
};

export type WindowGeometry = { frame: Rect4; zoomed: boolean; fullScreen: boolean; pageFullScreen?: boolean; miniaturized: boolean; visible: boolean; display: string | null; refused?: "offscreen" | "invalid"; transition?: "busy" | "timeout" };

export type DragPreviewShape = "hidden" | "pill" | "card";

export type WindowsNative = AppWindowsNative;
