import { useRef, useState } from "react";
import { Symbol } from "@ardia/shell";
import { useBrowser } from "../../browser/src/state/browser/store";
import { menuState } from "../../browser/src/state/commands/menuState";
import { useTheme } from "../../browser/src/components/ui/theme";
import { menuButtonPresses, showMenu } from "./menus";
import { linuxMenuShortcuts } from "./shortcuts";
import { appMenuChoice, appMenuItems } from "./appMenu";
import { currentEditMenu, currentEditTarget } from "./editTargets";
import { ardiaHost, reportHostError } from "./host";
import { updateMenuItem } from "@platform/updater";
import { hiddenAppMenuCommands, runAppMenuChoice } from "./appMenuActions";
import "./linkShareSurface";
import { refreshShareServices } from "./linkShare";
import { beginAppMenuOpen, mayPublishAppMenu } from "./appMenuOpen";

export async function openAppMenu(windowId: string, button: HTMLElement) {
  const state = useBrowser.getState();
  const shortcuts = new Map(linuxMenuShortcuts(state.settings.shortcuts, state.profileOrder, state.profiles).map((shortcut) => [
    shortcut.id,
    "key" in shortcut ? { key: shortcut.key, modifiers: shortcut.modifiers } : { key: "", modifiers: [] },
  ]));
  const current = beginAppMenuOpen(windowId);
  const focusOrder = [windowId, ...state.ui.focusOrder.filter((id) => id !== windowId)];
  const editTarget = currentEditTarget();
  const updates = ardiaHost ? await updateMenuItem(ardiaHost).catch(() => null) : null;
  await refreshShareServices();
  if (!mayPublishAppMenu(current, button)) return;
  const items = appMenuItems(menuState({ ...state, ui: { ...state.ui, focusOrder } }), shortcuts, hiddenAppMenuCommands(), { fullScreen: !!state.windows[windowId]?.fullScreen, edit: currentEditMenu(windowId, editTarget), updates });
  const { left, bottom } = button.getBoundingClientRect();
  const openedByPointer = !button.matches(":focus-visible");
  const id = await showMenu(items, undefined, { x: left, y: bottom + 4 });
  if (openedByPointer && document.activeElement === button) button.blur();
  return runAppMenuChoice(windowId, id ? appMenuChoice(id) : null, editTarget);
}

export function AppMenuButton({ windowId, size }: { windowId: string; size?: number }) {
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
      style={size ? { width: size, height: size, flex: `0 0 ${size}px` } : undefined}
      onPointerDown={presses.pointerDown}
      onClick={presses.click}
    >
      <Symbol name="line.3.horizontal" size={15} color={theme.icon} style={{ width: 18, height: 18 }} />
    </button>
  );
}
