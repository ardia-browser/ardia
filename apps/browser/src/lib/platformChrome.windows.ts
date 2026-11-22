import type { PopUpChrome, WindowButtonStyle, WindowChrome } from "./platformChrome";
import { BROWSER_BUTTON_LAYOUT, type WindowButtonLayout } from "./windowButtonLayout";

export const WINDOW_CHROME: WindowChrome = { leadingWidth: 0, trailingWidth: 171, titleBarHeight: 32, leadingButtons: [], trailingButtons: BROWSER_BUTTON_LAYOUT.trailing };

export const WINDOW_BUTTON_STYLES: readonly WindowButtonStyle[] = [];

export const applyWindowButtonStyle = (_style: WindowButtonStyle, _layout?: WindowButtonLayout): boolean => false;

export const POP_UP_CHROME: PopUpChrome = { indicator: "chevronDown", growsToItsTitle: true };

export const ADVANCED_PANE_SYMBOL = "slider.horizontal.2.square";

export const PANEL_FIELD_LIFT = -3;
