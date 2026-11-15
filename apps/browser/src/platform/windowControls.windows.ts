import { requireNativeModule } from "expo-modules-core";
import type { WindowControlsNative } from "@ardia/shell";
import type { PageRounding, WindowControls } from "./windowControls";

const Windows = requireNativeModule<WindowControlsNative>("ArdiaAppWindows");
const PageCovers = requireNativeModule<{
  setRadius(radius: number, windowId?: string): void;
  setCorners(corners: PageRounding["corners"], windowId: string): void;
}>("ArdiaPageCovers");

export const windowControls: WindowControls = {
  minimize: (windowId) => void Windows.minimizeWindow(windowId),
  toggleMaximize: (windowId) => void Windows.toggleMaximizeWindow(windowId),
  setCaptionRegions: (windowId, regions) => void Windows.setCaptionRegions(windowId, regions),
  setPageRounding: (windowId, rounding) => {
    PageCovers.setCorners(rounding.corners, windowId);
    PageCovers.setRadius(rounding.radius, windowId);
  },
};
