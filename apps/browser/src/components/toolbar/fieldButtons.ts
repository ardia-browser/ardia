import type { Settings } from "../../state/settings/settings";

export const fieldButtonsShown = (mode: Settings["addressBarButtons"], hovered: boolean) => hovered || mode === "always";

export const readerButtonShown = (reader: { available: boolean; active: boolean }, buttonsShown: boolean) => reader.active || (reader.available && buttonsShown);

export function sidebarFieldButtons(o: { mode: Settings["addressBarButtons"]; hovered: boolean; insecure: boolean; extensionsHeld: boolean }) {
  const shown = fieldButtonsShown(o.mode, o.hovered);
  return {
    leading: o.mode === "always" || o.insecure,
    siteControls: shown && o.mode === "hover" && !o.insecure,
    page: shown,
    extensions: shown || o.extensionsHeld,
  };
}
