import { requireNativeModule } from "expo-modules-core";
import type { WindowControlsNative } from "@ardia/shell";
import type { WindowControls } from "./windowControls";
import { t } from "../lib/uiLanguage";


const Windows = requireNativeModule<WindowControlsNative>(t(`ArdiaAppWindows`));

export const windowControls: WindowControls = {
  minimize: (windowId) => void Windows.minimizeWindow(windowId),
  toggleMaximize: (windowId) => void Windows.toggleMaximizeWindow(windowId),
  setCaptionRegions: (windowId, regions) => void Windows.setCaptionRegions(windowId, regions),
};
