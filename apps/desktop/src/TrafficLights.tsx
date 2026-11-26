import { TrafficLight, trafficLightPosition, trafficLightsOffWindow, useTrafficLightsPlace } from "./shims/web/windowChrome";
import { reportHostError } from "./host";
import { isLinuxUtility } from "./session";
import { linuxWindowMenu } from "./linuxWindowMenu";
import { closeFromWindowControls, minimizeWindow, toggleWindowMaximized } from "./captionControls";
import { useBrowser } from "../../browser/src/state/browser/store";
import { useFullscreenTab } from "../../browser/src/state/tabs/pageState";
import { useWindowButtonStyle } from "../../browser/src/state/windows/windowButtons";
import { useWindowFullScreen } from "../../browser/src/state/browser/hooks";
import { lightPressKeepsFocusWhereItWas, trafficLightsShown } from "./windowControlsRules";
import { drawsNativeTrafficLights } from "./nativeTrafficLights";

const controls = [
  { light: "close", label: "Close window", press: closeFromWindowControls },
  { light: "minimize", label: "Minimize window", press: minimizeWindow },
  { light: "zoom", label: "Maximize or restore window", press: toggleWindowMaximized },
] as const;

export function TrafficLights({ windowId }: { windowId: string }) {
  const place = useTrafficLightsPlace(windowId);
  const pageFullScreen = !!useFullscreenTab(windowId);
  const windowFullScreen = useWindowFullScreen(windowId);
  const theme = useBrowser((state) => state.ui.appDark ? "dark" : "light");
  const style = useWindowButtonStyle();
  if (drawsNativeTrafficLights() || !trafficLightsShown({ style, pageFullScreen, windowFullScreen })) return null;
  return (
    <div className="ardia-traffic-lights" aria-label="Window controls" role="group" inert={trafficLightsOffWindow(place) || undefined} onMouseDown={(e) => {
      if (lightPressKeepsFocusWhereItWas(e)) e.preventDefault();
    }} onContextMenu={(e) => {
      if (!linuxWindowMenu || isLinuxUtility(windowId)) return;
      e.preventDefault();
      void linuxWindowMenu.open(windowId).catch(reportHostError);
    }}>
      {controls.map(({ light, label, press }, index) => (
        <button key={light} className={`ardia-window-control ${light}`} data-ardia-window-control={light} aria-label={label} title={label} disabled={windowId === "import" && light === "zoom"} style={trafficLightPosition(place, index)} onClick={() => press(windowId)}>
          <TrafficLight name={light} theme={theme} />
          <span aria-hidden className="ardia-window-control-mark">{light === "close" ? "×" : light === "minimize" ? "−" : "+"}</span>
        </button>
      ))}
    </div>
  );
}
