import { memo } from "react";
import { controlsShown, WindowControls as SharedWindowControls, type WindowControlsProps } from "../../browser/src/components/window/WindowControls";
import { useFullscreenTab } from "../../browser/src/state/tabs/pageState";
import { reportHostError } from "./host";
import { isLinuxUtility } from "./session";
import { linuxWindowMenu } from "./linuxWindowMenu";
import { linuxControlsBehaviour, pressKeepsFocusWhereItWas } from "./windowControlsRules";

export { controlsShown, type WindowControlsProps };

export const WindowControls = memo(function WindowControls(props: WindowControlsProps) {
  const behaviour = linuxControlsBehaviour({ pageFullScreen: !!useFullscreenTab(props.windowId), hidden: !!props.hidden, utility: isLinuxUtility(props.windowId), windowMenu: !!linuxWindowMenu });
  if (!behaviour.rendered) return null;
  return (
    <div
      className="ardia-window-controls"
      style={{ display: "contents" }}
      inert={behaviour.inert || undefined}
      onMouseDown={(event) => {
        if (pressKeepsFocusWhereItWas(event)) event.preventDefault();
      }}
      onContextMenu={(event) => {
        if (!behaviour.windowMenuOnRightClick || !linuxWindowMenu) return;
        event.preventDefault();
        void linuxWindowMenu.open(props.windowId).catch(reportHostError);
      }}
    >
      <SharedWindowControls {...props} />
    </div>
  );
});
