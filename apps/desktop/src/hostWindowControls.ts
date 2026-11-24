import type { WindowControls } from "../../browser/src/platform/windowControls.ts";
import { hostModuleMethod, reportHostError } from "./host.ts";

export type { CaptionRegion, WindowControls } from "../../browser/src/platform/windowControls.ts";

const shellCall = (method: "minimizeWindow" | "toggleMaximizeWindow") => (windowId: string) => void hostModuleMethod("ArdiaShell", method)(windowId).catch(reportHostError);

export const windowControls: WindowControls = {
  minimize: shellCall("minimizeWindow"),
  toggleMaximize: shellCall("toggleMaximizeWindow"),
  setCaptionRegions() {},
};
