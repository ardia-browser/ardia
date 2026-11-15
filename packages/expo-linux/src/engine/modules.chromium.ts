import type { ComponentType } from "react";
import { EngineWebView } from "../../../expo-windows/src/engine/EngineWebView";
import { engineModules as windowsEngineModules } from "../../../expo-windows/src/engine/modules";
import { ClipView } from "../../../expo-windows/src/views/ClipView";
import { coveringPages } from "../chromium/covered";
import { engineAvailable } from "../chromium/host";
import { linuxMotion } from "../chromium/motion";
import { PopoverBubble, Surface } from "../views/adapters";

const live = engineAvailable();

export const engineModules: Record<string, Record<string, unknown>> = {
  ...(live ? windowsEngineModules : {}),
  ArdiaMotion: linuxMotion,
};

export const engineViews: Record<string, ComponentType<never>> = live
  ? {
      ArdiaWebView: EngineWebView as unknown as ComponentType<never>,
      ArdiaSurface: coveringPages(Surface, "ArdiaSurface") as unknown as ComponentType<never>,
      ArdiaPopoverBubble: coveringPages(PopoverBubble, "ArdiaPopoverBubble") as unknown as ComponentType<never>,
      ArdiaClipView: ClipView as unknown as ComponentType<never>,
    }
  : {};
