import type { Settings } from "../../state/settings/settings";

export const fieldButtonsShown = (mode: Settings["addressBarButtons"], hovered: boolean) => hovered || mode === "always";
