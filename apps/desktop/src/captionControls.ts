import { closeWindow } from "../../browser/src/state/windows/nativeWindow.ts";
import { reportHostError } from "./host.ts";

export { markCaptionRegions, minimizeWindow, toggleWindowMaximized } from "../../browser/src/state/windows/controls.ts";

const reportClose = (error: unknown) => {
  if ((error as { code?: string } | null)?.code !== "ERR_WINDOW_CLOSE_CANCELLED") reportHostError(error);
};

export const closeFromWindowControls = (windowId: string) => void closeWindow(windowId).catch(reportClose);
