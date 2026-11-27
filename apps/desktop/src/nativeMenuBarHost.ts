import { useBrowser } from "../../browser/src/state/browser/store";
import { useExtensions } from "../../browser/src/state/extensions/store";
import { menuState } from "../../browser/src/state/commands/menuState";
import { appMenuChoice, appMenuItems } from "./appMenu";
import { hiddenAppMenuCommands, runAppMenuChoice } from "./appMenuActions";
import { hostSupports, invokeHost, reportHostError, type ArdiaHost } from "./host";
import { linuxMenuShortcuts } from "./shortcuts";
import { onLinuxCommand } from "./shims/expo-modules-core";
import { createNativeMenuBar, menuPickFor, REQUEST_WINDOW_CLOSE_METHOD, SET_MAIN_MENU_METHOD, structuralMenuState, utilityMenuSpec, type MenuPickEvent } from "./nativeMenuBar";

const EDIT_ROLES = { disabled: new Set<string>() };

export function startNativeMenuPicks(host: ArdiaHost, windowId: string) {
  if (!hostSupports(SET_MAIN_MENU_METHOD, host)) return () => {};
  const subscription = onLinuxCommand((event) => {
    const id = menuPickFor(windowId, event as MenuPickEvent);
    if (id) void Promise.resolve(runAppMenuChoice(windowId, appMenuChoice(id))).catch(reportHostError);
  });
  return () => subscription.remove();
}

const menuOptions = (host: ArdiaHost) => ({ closeThroughHost: hostSupports(REQUEST_WINDOW_CLOSE_METHOD, host) });

export function startUtilityMenuBar(host: ArdiaHost, windowId: string) {
  const stopPicks = startNativeMenuPicks(host, windowId);
  if (hostSupports(SET_MAIN_MENU_METHOD, host)) void invokeHost(SET_MAIN_MENU_METHOD, { items: utilityMenuSpec(menuOptions(host)) }, host).catch(reportHostError);
  return stopPicks;
}

export function startNativeMenuBar(host: ArdiaHost, windowId: string) {
  const stopPicks = startNativeMenuPicks(host, windowId);
  const bar = createNativeMenuBar({
    options: menuOptions(host),
    supports: (method) => hostSupports(method, host),
    invoke: (method, args) => invokeHost(method, args, host),
    build: () => {
      const state = useBrowser.getState();
      const focusOrder = [windowId, ...state.ui.focusOrder.filter((id) => id !== windowId)];
      const shown = menuState({ ...state, ui: { ...state.ui, focusOrder } });
      const shortcuts = new Map(linuxMenuShortcuts(state.settings.shortcuts, state.profileOrder, state.profiles).map((shortcut) => [
        shortcut.id,
        "key" in shortcut ? { key: shortcut.key, modifiers: shortcut.modifiers } : { key: "", modifiers: [] },
      ]));
      const items = appMenuItems(structuralMenuState(shown), shortcuts, hiddenAppMenuCommands(), { edit: EDIT_ROLES });
      return { items, flags: { disabled: shown.disabled, checked: shown.checked, titles: shown.titles } };
    },
    subscribe: (changed) => {
      const stopBrowser = useBrowser.subscribe(changed);
      const stopExtensions = useExtensions.subscribe((next, prev) => {
        if (next.lists !== prev.lists) changed();
      });
      return () => {
        stopBrowser();
        stopExtensions();
      };
    },
    timeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    report: reportHostError,
  });
  return () => {
    bar.stop();
    stopPicks();
  };
}
