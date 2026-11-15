import { menuStore } from "../../../../../apps/browser/linux/src/menus/store";
import { addMenusListener, cancelRecording, devKeyEquivalent, devShortcutRecording, installKeys, pushKeyMap, recentMenuLog, recordShortcut, setTextInputFocused, textInputFocused } from "./keyboard";

export { installKeys };

export const keysModules: Record<string, Record<string, unknown>> = {
  ArdiaMenus: {
    setMenuState: async (state: Record<string, unknown> | null) => {
      menuStore.update(state ?? {});
      pushKeyMap();
    },
    setMenuBookmarks: async (bookmarks: Record<string, unknown> | null) => menuStore.updateBookmarks(bookmarks ?? {}),
    menuShortcuts: async () => menuStore.shortcutList(),
    activeShortcuts: async () => menuStore.activeBindings(),
    recordShortcut,
    cancelRecording,
    recentMenuLog: async () => recentMenuLog(),
    updateMenu: async () => {},
    addListener: addMenusListener,
  },
  ArdiaDev: { devKeyEquivalent, devShortcutRecording },
  ArdiaFocus: {
    textInputFocused,
    setTextInputFocused: async (focused: boolean) => setTextInputFocused(!!focused),
  },
};
