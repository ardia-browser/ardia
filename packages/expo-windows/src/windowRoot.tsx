import { createElement, type ReactNode } from "react";
import { AppRegistry, TurboModuleRegistry } from "react-native";
import type { AppNative } from "@ardia/shell";
import type { WindowsHostModule } from "./nativeModuleTypes";
import { WindowIdContext } from "./engine/windowId";
import { PopupWindow } from "./engine/PopupWindow";
import { isPopupWindowId } from "./engine/popupWindows";
import { FadeLab } from "./fadeLab";
import { requireNativeModule } from "./modules";
import { SelfCheckStage } from "./selfCheck/stage";
import { OutsidePressRoot } from "./views/index";
import { TitleBandDrag } from "./windowDragRegion";

type RootProps = { children?: ReactNode; initialProps?: { windowId?: unknown } | null };

const selfChecking = () => !!TurboModuleRegistry.get<WindowsHostModule>("ArdiaWindowsHost")?.getConstants?.()?.selfCheck;

function WindowRoot({ children, initialProps }: RootProps) {
  const windowId = typeof initialProps?.windowId === "string" ? initialProps.windowId : "";
  const stage = stagesSelfChecks ? createElement(SelfCheckStage) : null;
  const lab = showsFadeLab && !isPopupWindowId(windowId) ? createElement(FadeLab) : null;
  const content = isPopupWindowId(windowId) ? createElement(PopupWindow, { windowId }) : children;
  return createElement(WindowIdContext.Provider, { value: windowId }, createElement(OutsidePressRoot, null, createElement(TitleBandDrag, null, content), stage, lab));
}

let installed = false;
let stagesSelfChecks = false;
let showsFadeLab = false;

export function installWindowRoot() {
  if (installed) return;
  installed = true;
  stagesSelfChecks = selfChecking();
  try {
    showsFadeLab = !!requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test.fadeLab;
  } catch {
    showsFadeLab = false;
  }
  AppRegistry.setWrapperComponentProvider(() => WindowRoot);
}
