import { TRAFFIC_LIGHTS_WIDTH, type WindowButton, type WindowButtonLayout } from "./windowButtonLayout";

export type WindowChrome = {
  leadingWidth: number;
  trailingWidth: number;
  titleBarHeight: number;
  leadingButtons: readonly WindowButton[];
  trailingButtons: readonly WindowButton[];
};

export type WindowButtonStyle = "native" | "trafficLights" | "hidden";

export type PopUpChrome = {
  indicator: "accentUpDown" | "chevronDown";
  growsToItsTitle: boolean;
};

export const WINDOW_CHROME: WindowChrome = { leadingWidth: TRAFFIC_LIGHTS_WIDTH, trailingWidth: 0, titleBarHeight: 0, leadingButtons: [], trailingButtons: [] };

export const WINDOW_BUTTON_STYLES: readonly WindowButtonStyle[] = [];

export const applyWindowButtonStyle = (_style: WindowButtonStyle, _layout?: WindowButtonLayout): boolean => false;

export const POP_UP_CHROME: PopUpChrome = { indicator: "accentUpDown", growsToItsTitle: false };

export const ADVANCED_PANE_SYMBOL = "slider.horizontal.3";

export const PANEL_FIELD_LIFT = 0;
