export type WindowChrome = {
  leadingWidth: number;
  trailingWidth: number;
  titleBarHeight: number;
};

export type PopUpChrome = {
  indicator: "accentUpDown" | "chevronDown";
  growsToItsTitle: boolean;
};

export const WINDOW_CHROME: WindowChrome = { leadingWidth: 78, trailingWidth: 0, titleBarHeight: 0 };

export const POP_UP_CHROME: PopUpChrome = { indicator: "accentUpDown", growsToItsTitle: false };

export const ADVANCED_PANE_SYMBOL = "slider.horizontal.3";

export const PANEL_FIELD_LIFT = 0;
