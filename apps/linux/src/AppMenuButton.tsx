import { useRef, useState } from "react";
import { Symbol, closeWindow, emitCommand } from "@ardia/shell";
import { useBrowser } from "../../browser/src/state/browser/store";
import { menuState } from "../../browser/src/state/commands/menuState";
import { useTheme } from "../../browser/src/components/ui/theme";
import { menuButtonPresses, showMenu } from "./menus";
import { linuxMenuShortcuts } from "./shortcuts";
import { appMenuChoice, appMenuItems } from "./appMenu";
import { minimizeAllWindows } from "./windowMenu";
import { currentEditMenu, currentEditTarget, runEdit } from "./editTargets";
import { hostModuleMethod, reportHostError } from "./host";
import { linuxCapabilities, unavailableCommands } from "./hostCapabilities";
import { videoTourUrl } from "../../browser/src/state/onboarding/tour";
import { showToast } from "../../browser/src/state/app/toasts";
import { engineInfo, systemInfo } from "../../browser/src/platform/app";
import "./linkShareSurface";

const hiddenCommands = () => {
  const hidden = unavailableCommands(linuxCapabilities());
  hidden.delete("emailPageLocation");
  if (!videoTourUrl()) hidden.add("videoTour");
  if (!systemInfo().releaseNotesURL) hidden.add("releaseNotes");
  return hidden;
};

async function showAbout(windowId: string) {
  const { appName, appVersion, appBuild } = systemInfo();
  const engine = await engineInfo().catch(() => null);
  showToast(windowId, `${appName} ${appVersion} (${appBuild})`, engine?.chromiumVersion ? `ArdiaCore on Chromium ${engine.chromiumVersion}` : undefined);
}

export async function openAppMenu(windowId: string, button: HTMLElement) {
  const state = useBrowser.getState();
  const shortcuts = new Map(linuxMenuShortcuts(state.settings.shortcuts, state.profileOrder).map((shortcut) => [
    shortcut.id,
    "key" in shortcut ? { key: shortcut.key, modifiers: shortcut.modifiers } : { key: "", modifiers: [] },
  ]));
  const focusOrder = [windowId, ...state.ui.focusOrder.filter((id) => id !== windowId)];
  const editTarget = currentEditTarget();
  const items = appMenuItems(menuState({ ...state, ui: { ...state.ui, focusOrder } }), shortcuts, hiddenCommands(), { fullScreen: !!state.windows[windowId]?.fullScreen, edit: currentEditMenu(windowId, editTarget) });
  const { left, bottom } = button.getBoundingClientRect();
  const openedByPointer = !button.matches(":focus-visible");
  const id = await showMenu(items, undefined, { x: left, y: bottom + 4 });
  if (openedByPointer && document.activeElement === button) button.blur();
  const choice = id ? appMenuChoice(id) : null;
  if (!choice) return;
  if (choice.kind === "about") return showAbout(windowId);
  if (choice.kind === "edit") return runEdit(windowId, choice.action, editTarget).catch(reportHostError);
  if (choice.kind === "command") return emitCommand({ command: choice.command, arg: choice.arg, windowId });
  if (choice.action === "close") return void closeWindow(windowId).catch(reportHostError);
  if (choice.action === "minimizeAll") return void minimizeAllWindows(useBrowser.getState().windowOrder);
  void hostModuleMethod("ArdiaShell", choice.action === "minimize" ? "minimizeWindow" : "toggleMaximizeWindow")(windowId).catch(reportHostError);
}

export function AppMenuButton({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const button = useRef<HTMLButtonElement>(null);
  const [presses] = useState(() => menuButtonPresses(() => {
    if (button.current) void openAppMenu(windowId, button.current).catch(reportHostError);
  }));
  return (
    <button
      ref={button}
      className="ardia-header-button ardia-app-menu-button"
      data-ardia-app-menu
      aria-label="Menu"
      aria-haspopup="menu"
      title="Menu"
      onPointerDown={presses.pointerDown}
      onClick={presses.click}
    >
      <Symbol name="line.3.horizontal" size={15} color={theme.icon} style={{ width: 18, height: 18 }} />
    </button>
  );
}
