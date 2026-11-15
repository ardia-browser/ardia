import { createElement, forwardRef, Fragment, type ComponentType } from "react";
import { View } from "react-native";
import { EngineWebView } from "../../../expo-windows/src/engine/EngineWebView";
import { engineModules as windowsEngineModules } from "../../../expo-windows/src/engine/modules";
import { ClipView } from "../../../expo-windows/src/views/ClipView";
import { coveringPages } from "../chromium/covered";
import { engineAvailable, pagesUnderUi } from "../chromium/host";
import { withLinuxDomains } from "../chromium/linuxDomains";
import { linuxMotion } from "../chromium/motion";
import { PopoverBubble, Surface } from "../views/adapters";

const live = engineAvailable();

const SLOT_MARKER_STYLE = { position: "absolute", width: 0, height: 0 } as const;

type SlotProps = { tabId?: string };

const PageSlot = forwardRef<unknown, SlotProps>(function PageSlot(props, ref) {
  const marker = createElement(View, { key: "slot", pointerEvents: "none", style: SLOT_MARKER_STYLE, dataSet: { ardiaPageSlot: props.tabId ?? "" } } as never);
  const page = createElement(EngineWebView as unknown as ComponentType<SlotProps & { ref: unknown }>, { ...props, key: "page", ref });
  return createElement(Fragment, null, marker, page);
});

export const engineModules: Record<string, Record<string, unknown>> = {
  ...(live ? withLinuxDomains(windowsEngineModules) : {}),
  ArdiaMotion: linuxMotion,
};

export const engineViews: Record<string, ComponentType<never>> = live
  ? {
      ArdiaWebView: (pagesUnderUi() ? PageSlot : EngineWebView) as unknown as ComponentType<never>,
      ArdiaSurface: coveringPages(Surface, "ArdiaSurface") as unknown as ComponentType<never>,
      ArdiaPopoverBubble: coveringPages(PopoverBubble, "ArdiaPopoverBubble") as unknown as ComponentType<never>,
      ArdiaClipView: ClipView as unknown as ComponentType<never>,
    }
  : {};
