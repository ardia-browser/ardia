import type { EventSubscription } from "expo-modules-core";
import type { CommandEvent } from "./commands";
import { nativeModule } from "./nativeModules";
import type { MenuShortcut, ShortcutModifier } from "./system";
import type { MenusNative } from "./generated/native";

export type MenuItem =
  | { separator: true }
  | {
      id: string;
      title: string;
      symbol?: string;
      swatch?: string;
      swatchDark?: string;
      key?: string;
      modifiers?: ("command" | "shift" | "option" | "control")[];
      enabled?: boolean;
      checked?: boolean;
      alternate?: boolean;
      keepOpen?: boolean;
      children?: MenuItem[];
      share?: boolean;
    };

export type MenuPickEvent = { command: "menu.pick"; arg: string };

export type MenuEntry = { id: string; title: string; current?: boolean };
export type MenuBookmark = { id: string; title: string; url?: string; children?: MenuBookmark[] };

export type MenuState = {
  checked: string[];
  disabled: string[];
  titles: Record<string, string>;
  profiles: MenuEntry[];
  windows: MenuEntry[];
  bookmarkFolders: MenuEntry[];
  recentBookmarks: MenuBookmark[];
  bookmarksBar: MenuBookmark[];
  otherBookmarks: MenuBookmark[];
  bookmarksShown?: boolean;
  recentlyClosed: MenuEntry[];
  recentlyClosedGroups?: MenuEntry[];
  warnBeforeQuitting: boolean;
  warnBeforeClosingWindow?: boolean;
  undoReopensClosedTab?: boolean;
  linksOpenInLittleArdia?: boolean;
  littleArdiaShortcutFromAnyApp?: boolean;
  downloadsInProgress?: number;
  extensions?: { id: string; title: string; icon?: string | null; enabled: boolean }[];
  shortcuts?: Record<string, string[][]>;
  mouseShortcuts?: Record<string, string[]>;
};

export type MenuBookmarkKey = "bookmarkFolders" | "recentBookmarks" | "bookmarksBar" | "otherBookmarks";

export type SurfaceItem = {
  path: number[];
  title: string;
  enabled?: boolean;
  checked?: boolean;
  mixed?: boolean;
  separator: boolean;
  hidden?: boolean;
  alternate?: boolean;
  key?: string;
  command?: string | number;
  arg?: string;
  action?: string;
  ref?: string;
  dynamic?: boolean;
  submenu?: SurfaceItem[];
};

export type OpenSurface = {
  id: string;
  kind: "select" | "page" | "app" | "menuBar" | "other";
  tab?: string;
  window?: string;
  captured?: boolean;
  openedAt?: number;
  link?: string;
  items?: SurfaceItem[];
};

export type SurfaceEvent =
  | (OpenSurface & { type: "menuOpened" })
  | { type: "menuDropped"; id: string; kind: OpenSurface["kind"] };

export type { MenusNative };

let menusShown = 0;
const menuWatchers = new Set<() => void>();
const menusChanged = (by: number) => {
  menusShown += by;
  for (const watcher of menuWatchers) watcher();
};
export const menuShown = () => menusShown > 0;
export function watchMenus(watcher: () => void): () => void {
  menuWatchers.add(watcher);
  return () => void menuWatchers.delete(watcher);
}

export function showMenu(items: MenuItem[], onKeepOpenPick?: (id: string) => MenuItem[]): Promise<string | null> {
  const menus = nativeModule("ArdiaMenus");
  const picks = onKeepOpenPick && menus.addListener("onCommand", (e) => e.command === "menu.pick" && void menus.updateMenu(onKeepOpenPick(e.arg)));
  menusChanged(1);
  return Promise.resolve(menus.showMenu(items)).finally(() => {
    picks?.remove();
    menusChanged(-1);
  });
}
