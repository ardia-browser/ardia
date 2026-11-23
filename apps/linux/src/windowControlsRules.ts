import { LIGHTS_CENTER, lightsPlaceOffWindow } from "../../browser/src/state/windows/dockMotion";
import { WINDOW_CONTROLS, windowControlsWidth } from "../../browser/src/lib/windowChrome";

type LinuxControlsState = { pageFullScreen: boolean; hidden: boolean; utility: boolean; windowMenu: boolean; shown?: boolean };

export const windowButtonsRendered = ({ placed, pageFullScreen }: { placed: boolean; pageFullScreen: boolean }): boolean => placed && !pageFullScreen;

export const trafficLightsShown = ({ style, pageFullScreen, windowFullScreen }: { style: string; pageFullScreen: boolean; windowFullScreen: boolean }): boolean =>
  style === "trafficLights" && !pageFullScreen && !windowFullScreen;

type LeadingPlace = { center: readonly [number, number]; trailing: boolean };

export const leadingButtonsShown = ({ count, pageFullScreen, windowFullScreen, place }: { count: number; pageFullScreen: boolean; windowFullScreen: boolean; place: LeadingPlace }): boolean =>
  count > 0 && !pageFullScreen && !windowFullScreen && !lightsPlaceOffWindow(place);

const LIGHTS_PAST_START = LIGHTS_CENTER[0] - WINDOW_CONTROLS.edge;

export const leadingControlsInset = ({ center, trailing }: LeadingPlace, count: number): number =>
  trailing ? center[0] + LIGHTS_PAST_START - windowControlsWidth(count) : center[0] - LIGHTS_PAST_START;

export const linuxControlsBehaviour = ({ pageFullScreen, hidden, utility, windowMenu, shown = true }: LinuxControlsState) => {
  const rendered = windowButtonsRendered({ placed: true, pageFullScreen });
  return { rendered, inert: hidden, takesInput: rendered && !hidden && shown, windowMenuOnRightClick: windowMenu && !utility };
};

const CAPTION_BUTTON = '[role="button"]';
const TRAFFIC_LIGHT = ".ardia-window-control";

const primaryPressOn = (selector: string) => (event: { button: number; target: unknown }): boolean =>
  event.button === 0 && !!event.target && typeof event.target === "object" && "closest" in event.target && !!(event.target as Element).closest(selector);

export const pressKeepsFocusWhereItWas = primaryPressOn(CAPTION_BUTTON);

export const lightPressKeepsFocusWhereItWas = primaryPressOn(TRAFFIC_LIGHT);
