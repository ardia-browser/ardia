import type { ArdiaHost } from "../host";
import { setDesktopButtonLayout } from "../../../browser/src/state/windows/windowButtons.ts";

export const WINDOWS_BUTTON_LAYOUT = ":minimize,maximize,close";

export const followButtonLayout = (_host: ArdiaHost, set: (layout: string | null, tiling: boolean) => void = setDesktopButtonLayout): (() => void) => {
  set(WINDOWS_BUTTON_LAYOUT, false);
  return () => {};
};
