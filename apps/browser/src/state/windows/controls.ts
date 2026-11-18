import { windowControls, type CaptionRegion } from "../../platform/windowControls";
import { requestWindowClose } from "./windowClose";

export const minimizeWindow = (windowId: string) => windowControls.minimize(windowId);

export const toggleWindowMaximized = (windowId: string) => windowControls.toggleMaximize(windowId);

export const closeFromWindowControls = (windowId: string) => requestWindowClose(windowId);

export const markCaptionRegions = (windowId: string, regions: readonly CaptionRegion[]) => windowControls.setCaptionRegions(windowId, regions);
