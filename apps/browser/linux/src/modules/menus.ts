import { BrowserWindow, Menu, nativeImage, type MenuItemConstructorOptions } from "electron";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineModule } from "../bridge";
import { count } from "../counts";
import { testFlag } from "../launch";
import { activation, note } from "../log";
import { dataDirectory, isBackground } from "../paths";
import { popUpOver } from "../popupMenus";
import { electronAccelerator, linuxComboFromStored, storedCombo } from "../menus/keys";
import { finishRecording, keyboardState, startRecording } from "../menus/keyboard";
import { menuStore } from "../menus/store";
import { appWindow, appWindowIds, onAppWindowCreated } from "../windows";

type MenuItem = {
  separator?: boolean;
  id?: string;
  title?: string;
  symbol?: string;
  swatch?: string;
  swatchDark?: string;
  key?: string;
  modifiers?: string[];
  enabled?: boolean;
  checked?: boolean;
  alternate?: boolean;
  keepOpen?: boolean;
  children?: MenuItem[];
  share?: boolean;
};

const recentLog: string[] = [];

function menuLog(line: string): void {
  note("menu", line);
  recentLog.push(line);
  while (recentLog.length > 40) recentLog.shift();
}

const visible = (items: MenuItem[]) => items.filter((item) => !item.separator && !item.alternate);

function joinedTitles(items: MenuItem[], describe: boolean): string {
  return visible(items)
    .filter((item) => item.title)
    .map((item) => `${item.title}${describe && item.checked ? " ✓" : ""}`)
    .join(" | ");
}

function reportItems(items: MenuItem[], path: string): void {
  activation(`menu items: ${path}: ${joinedTitles(items, true)}`);
  for (const item of visible(items)) if (item.children?.length) reportItems(item.children, `${path} › ${item.title}`);
}

function enabledIds(items: MenuItem[], into = new Set<string>()): Set<string> {
  for (const item of visible(items)) {
    if (item.enabled === false) continue;
    if (item.children?.length) enabledIds(item.children, into);
    else if (item.id) into.add(item.id);
  }
  return into;
}

function testPick(items: MenuItem[]): string | null {
  const file = join(dataDirectory(), "menu.json");
  writeFileSync(file, JSON.stringify(items, null, 2));
  let pick = "";
  try {
    pick = readFileSync(`${file}.pick`, "utf8").trim();
    rmSync(`${file}.pick`, { force: true });
  } catch {}
  return pick && enabledIds(items).has(pick) ? pick : null;
}

function swatchImage(hex: string | undefined): Electron.NativeImage | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match) return undefined;
  const value = parseInt(match[1]!, 16);
  const size = 12;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x - 5.5;
      const dy = y - 5.5;
      const inside = dx * dx + dy * dy <= 30;
      const at = (y * size + x) * 4;
      pixels[at] = value & 0xff;
      pixels[at + 1] = (value >> 8) & 0xff;
      pixels[at + 2] = (value >> 16) & 0xff;
      pixels[at + 3] = inside ? 0xff : 0;
    }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function acceleratorOf(item: MenuItem): string | undefined {
  if (!item.key) return undefined;
  const stored = storedCombo([item.key, ...(item.modifiers ?? [])]);
  if (!stored) return undefined;
  const combo = menuStore.linuxComboForMac(stored) ?? linuxComboFromStored(stored) ?? stored;
  return electronAccelerator(combo);
}

const labelOf = (title: string | undefined) => (title ?? "").replace(/&/g, "&&");

function template(items: MenuItem[], choose: (id: string) => void): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    if (item.alternate) continue;
    if (item.separator) {
      if (out.length && out[out.length - 1]!.type !== "separator") out.push({ type: "separator" });
      continue;
    }
    const options: MenuItemConstructorOptions = { label: labelOf(item.title), enabled: item.enabled !== false };
    if (item.children?.length) options.submenu = template(item.children, choose);
    else {
      const id = item.id ?? "";
      options.click = () => choose(id);
      const accelerator = acceleratorOf(item);
      if (accelerator) {
        options.accelerator = accelerator;
        options.registerAccelerator = false;
      }
    }
    if (item.checked) {
      options.type = "checkbox";
      options.checked = true;
    }
    const icon = swatchImage(item.swatch);
    if (icon) options.icon = icon;
    out.push(options);
  }
  while (out.length && out[out.length - 1]!.type === "separator") out.pop();
  return out;
}

const focusOrder: string[] = [];

onAppWindowCreated((id, window) => {
  const bringForward = () => {
    const at = focusOrder.indexOf(id);
    if (at >= 0) focusOrder.splice(at, 1);
    focusOrder.push(id);
  };
  bringForward();
  window.on("focus", bringForward);
  window.once("closed", () => {
    const at = focusOrder.indexOf(id);
    if (at >= 0) focusOrder.splice(at, 1);
  });
});

function menuOwner(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) return focused;
  count("popup_menus_without_focus");
  const shown = (id: string) => {
    const window = appWindow(id);
    return window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() ? window : undefined;
  };
  for (const id of [...focusOrder].reverse()) {
    const window = shown(id);
    if (window) return window;
  }
  for (const id of appWindowIds()) {
    const window = shown(id);
    if (window) return window;
  }
  return undefined;
}

function showMenu(items: MenuItem[]): Promise<string | null> {
  menuLog(`showMenu asked: ${visible(items).length} items`);
  if (testFlag("appMenu")) return Promise.resolve(testPick(items));
  if (isBackground()) {
    menuLog(`pop-up menu not shown in a background instance: ${joinedTitles(items, false)}`);
    activation(`pop-up menu (not shown): ${joinedTitles(items, false)}`);
    reportItems(items, "pop-up menu");
    return Promise.resolve(null);
  }
  const owner = menuOwner();
  if (!owner) {
    count("popup_menus_unshown");
    menuLog("pop-up menu not shown: no app window to show it over");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const menu = Menu.buildFromTemplate(template(items, (id) => (chosen = id)));
    keyboardState.trackingMenu = true;
    popUpOver(menu, owner, () => {
      keyboardState.trackingMenu = false;
      setImmediate(() => resolve(chosen));
    });
  });
}

defineModule("ArdiaMenus", {
  async: {
    showMenu,
    updateMenu: async () => {},
    setMenuState: async (state: Record<string, unknown>) => menuStore.update(state ?? {}),
    setMenuBookmarks: async (bookmarks: Record<string, unknown>) => menuStore.updateBookmarks(bookmarks),
    menuShortcuts: async () => menuStore.shortcutList(),
    activeShortcuts: async () => menuStore.activeBindings(),
    recentMenuLog: async () => [...recentLog],
    recordShortcut: () => startRecording(),
    cancelRecording: async () => finishRecording(null),
  },
});
