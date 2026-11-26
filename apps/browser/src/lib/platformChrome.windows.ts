import type { PopUpChrome, WindowButtonStyle, WindowChrome } from "./platformChrome";
import type { WindowButtonLayout } from "./windowButtonLayout";
import { CAPTION_WINDOW_CHROME } from "./captionChrome";

export { ADVANCED_PANE_SYMBOL, PANEL_FIELD_LIFT } from "./captionChrome";

export const WINDOW_CHROME: WindowChrome = { ...CAPTION_WINDOW_CHROME };

export const WINDOW_BUTTON_STYLES: readonly WindowButtonStyle[] = [];

export const applyWindowButtonStyle = (_style: WindowButtonStyle, _layout?: WindowButtonLayout): boolean => false;

export const POP_UP_CHROME: PopUpChrome = { indicator: "chevronDown", growsToItsTitle: true };

export const REFRESH_ARROW_RING_OFFSET = { x: 0.45, y: 0.6 } as const;
