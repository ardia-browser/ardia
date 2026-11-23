import { WindowControls } from "./WindowControls";
import { useTrafficLightsPlace } from "./shims/web/windowChrome";
import { leadingButtonsShown, leadingControlsInset } from "./windowControlsRules";
import { useFullscreenTab } from "../../browser/src/state/tabs/pageState";
import { useWindowFullScreen } from "../../browser/src/state/browser/hooks";
import { useWindowChrome } from "../../browser/src/state/windows/windowButtons";
import { windowButtonsFor } from "../../browser/src/lib/windowChrome";
import { TintInk } from "../../browser/src/components/ui/TintInk";

type LeadingWindowControlsProps = { windowId: string; size: number; centerY?: number; maximizable?: boolean };

export function LeadingWindowControls({ windowId, size, centerY, maximizable = true }: LeadingWindowControlsProps) {
  const chrome = useWindowChrome();
  const place = useTrafficLightsPlace(windowId);
  const pageFullScreen = !!useFullscreenTab(windowId);
  const windowFullScreen = useWindowFullScreen(windowId);
  const buttons = windowButtonsFor(chrome.leadingButtons, { menu: false, maximizable });
  if (!leadingButtonsShown({ count: buttons.length, pageFullScreen, windowFullScreen, place })) return null;
  return (
    <TintInk>
      <WindowControls
        windowId={windowId}
        buttons={buttons}
        centerY={centerY ?? place.center[1]}
        size={size}
        maximizable={maximizable}
        leading={!place.trailing}
        inset={leadingControlsInset(place, buttons.length)}
      />
    </TintInk>
  );
}
