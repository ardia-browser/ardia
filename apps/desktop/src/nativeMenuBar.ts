import type { MenuItem, MenuState } from "@ardia-real/shell";
import { appMenuChoice } from "./appMenu.ts";
import { EDIT_ITEMS } from "./editCommands.ts";
import { MODIFIER_FLAGS } from "@platform/shortcutKeys";

export const SET_MAIN_MENU_METHOD = "ArdiaShell.setMainMenu";
export const SET_MENU_STATE_METHOD = "ArdiaShell.setMenuState";
export const SET_MENU_BOOKMARKS_METHOD = "ArdiaShell.setMenuBookmarks";
export const MENU_PICK = "menu.pick";
export const NATIVE_MENU_MAX_ITEMS = 400;
export const NATIVE_MENU_MAX_DEPTH = 4;
export const NATIVE_MENU_SYNC_MS = 120;
const MAX_TITLE_BYTES = 200;
const MAX_ARGUMENT_BYTES = 2048;
const MAX_STATE_ID_BYTES = 96 + 1 + MAX_ARGUMENT_BYTES;
const COMMAND = /^[A-Za-z0-9._:-]{1,96}$/;
const STRUCTURAL_DISABLED: ReadonlySet<string> = new Set(["togglePinnedFold", "togglePin:tile"]);

export type NativeMenuItem = {
  title?: string;
  defaultTitle?: string;
  command?: string;
  arg?: string;
  id?: string;
  key?: string;
  modifiers?: number;
  role?: string;
  enabled?: boolean;
  checked?: boolean;
  fixedCheck?: boolean;
  separator?: true;
  children?: NativeMenuItem[];
};

export type MenuFlags = Pick<MenuState, "disabled" | "checked" | "titles">;
export const NO_MENU_FLAGS: MenuFlags = { disabled: [], checked: [], titles: {} };

const APPKIT = { shift: 1, control: 2, option: 4, command: 8 } as const;
const APPKIT_FOR_CHROMIUM: Readonly<Record<number, number>> = { 2: APPKIT.shift, 4: APPKIT.control, 8: APPKIT.option, 16: APPKIT.command };
const DESKTOP_MODIFIER_BITS: Record<string, number> = Object.fromEntries(
  Object.entries(MODIFIER_FLAGS).map(([modifier, flag]) => [modifier, APPKIT_FOR_CHROMIUM[flag] ?? 0]),
);
const SUBMENU_ROLES: Record<string, string> = { "menu:Window": "windowMenu", "menu:Help": "helpMenu", "menu:Bookmarks": "bookmarksMenu", "menu:Share": "shareServices" };
const SHELL_SHARE_ITEMS: ReadonlySet<string> = new Set(["share:via:copy", "share:via:email"]);
const shellShareItems = (children: MenuItem[]) => children.filter((child) => !("separator" in child) && SHELL_SHARE_ITEMS.has(child.id));
const ITEM_ROLES: Record<string, string> = {
  ...Object.fromEntries(EDIT_ITEMS.map((item) => [item.id, item.action])),
  about: "about",
  "window:minimize": "minimize",
  "window:maximize": "zoom",
  "std:toggleFullScreen:": "toggleFullScreen",
};
const SKIPPED: ReadonlySet<string> = new Set(["window:minimizeAll"]);
const MAC_SHORTCUTS: Record<string, Pick<NativeMenuItem, "key" | "modifiers">> = {
  "std:quit:": { key: "q", modifiers: APPKIT.command },
  "std:toggleFullScreen:": { key: "f", modifiers: APPKIT.control | APPKIT.command },
  "std:undo:": { key: "z", modifiers: APPKIT.command },
  "std:redo:": { key: "z", modifiers: APPKIT.command | APPKIT.shift },
  "std:cut:": { key: "x", modifiers: APPKIT.command },
  "std:copy:": { key: "c", modifiers: APPKIT.command },
  "std:paste:": { key: "v", modifiers: APPKIT.command },
  "std:pasteAndMatchStyle:": { key: "v", modifiers: APPKIT.command | APPKIT.option | APPKIT.shift },
  "std:selectAll:": { key: "a", modifiers: APPKIT.command },
  "window:minimize": { key: "m", modifiers: APPKIT.command },
  "window:close": { key: "w", modifiers: APPKIT.command | APPKIT.shift },
};
const CLOSE_WINDOW = "window:close";
export const REQUEST_WINDOW_CLOSE_METHOD = "ArdiaShell.requestWindowClose";
export type NativeMenuOptions = { appName?: string; closeThroughHost?: boolean };
const APP_MENU = "menu:Ardia";
const QUIT = "std:quit:";
const appMenuStandardItems = (appName: string): NativeMenuItem[] => [
  { separator: true },
  { title: "Services", role: "services", children: [] },
  { separator: true },
  { title: `Hide ${appName}`, role: "hide", key: "h", modifiers: APPKIT.command },
  { title: "Hide Others", role: "hideOthers", key: "h", modifiers: APPKIT.command | APPKIT.option },
  { title: "Show All", role: "showAll" },
  { separator: true },
];
const NAMED_KEYS: Record<string, string> = {
  "\r": "Enter", "\t": "Tab", "\u0008": "Backspace", "\u001b": "Escape", " ": "Space",
  "": "Up", "": "Down", "": "Left", "": "Right", "": "Delete", "": "Home", "": "End",
  Enter: "Enter", Return: "Enter", Tab: "Tab", Backspace: "Backspace", Escape: "Escape", Space: "Space", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Up: "Up", Down: "Down", Left: "Left", Right: "Right",
  Home: "Home", End: "End",
};

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const controls = /[\u0000-\u001f\u007f]/g;
const control = /[\u0000-\u001f\u007f]/;

export function nativeMenuTitle(raw: string): string {
  const clean = raw.replace(controls, " ").trim();
  if (byteLength(clean) <= MAX_TITLE_BYTES) return clean;
  let kept = "";
  let used = 0;
  for (const point of clean) {
    const size = byteLength(point);
    if (used + size > MAX_TITLE_BYTES) break;
    kept += point;
    used += size;
  }
  return kept.trim();
}

export const desktopModifierBits = (modifiers: readonly string[]) => modifiers.reduce((bits, modifier) => bits | (DESKTOP_MODIFIER_BITS[modifier] ?? 0), 0);

export function nativeMenuKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const named = NAMED_KEYS[key];
  if (named) return named;
  const point = key.codePointAt(0)!;
  if (key.length === 1 && point >= 0xf704 && point <= 0xf717) return `F${point - 0xf703}`;
  if (/^F([1-9]|1[0-9]|20)$/.test(key)) return key;
  if (key.length === 1 && point >= 0x21 && point < 0x7f) return key.toLowerCase();
  return undefined;
}

const shortcutOf = (item: Extract<MenuItem, { id: string }>): Pick<NativeMenuItem, "key" | "modifiers"> => {
  const fixed = MAC_SHORTCUTS[item.id];
  if (fixed) return fixed;
  const key = nativeMenuKey(item.key);
  if (!key) return {};
  const modifiers = desktopModifierBits(item.modifiers ?? []);
  return { key, modifiers };
};

const tidy = (items: NativeMenuItem[]) =>
  items.filter((item, index) => !item.separator || (index > 0 && index < items.length - 1 && !items[index - 1]!.separator));

const staticBookmarkItems = (children: readonly MenuItem[]) => {
  const cut = children.findIndex((child) => "id" in child && (child.id.startsWith("folder:") || child.id.startsWith("header:")));
  return cut < 0 ? children : children.slice(0, cut);
};

export function structuralMenuState(state: MenuState): MenuState {
  return { ...state, bookmarkFolders: [], recentBookmarks: [], bookmarksBar: [], otherBookmarks: [], disabled: state.disabled.filter((id) => STRUCTURAL_DISABLED.has(id)), checked: [], titles: {} };
}

export function nativeMenuSpec(items: readonly MenuItem[], flags: MenuFlags = NO_MENU_FLAGS, { appName = "Ardia", closeThroughHost = false }: NativeMenuOptions = {}): NativeMenuItem[] {
  const disabled = new Set(flags.disabled);
  const checked = new Set(flags.checked);
  let budget = NATIVE_MENU_MAX_ITEMS;
  const take = () => {
    if (budget <= 0) return false;
    budget -= 1;
    return true;
  };

  const convert = (item: MenuItem, depth: number): NativeMenuItem | null => {
    if ("separator" in item) return take() ? { separator: true } : null;
    if (item.alternate || SKIPPED.has(item.id)) return null;
    const title = nativeMenuTitle(item.title);
    if (item.children) {
      if (depth >= NATIVE_MENU_MAX_DEPTH || !take()) return null;
      const role = SUBMENU_ROLES[item.id];
      const source = role === "bookmarksMenu" ? staticBookmarkItems(item.children) : role === "shareServices" ? shellShareItems(item.children) : item.children;
      const converted = source.map((child) => convert(child, depth + 1)).filter((child): child is NativeMenuItem => !!child);
      const quit = item.id === APP_MENU ? converted.findIndex((child) => child.id === QUIT) : -1;
      if (quit >= 0) converted.splice(quit, 0, ...appMenuStandardItems(appName).filter(() => take()));
      return { title: title || "Untitled", ...(role ? { role } : {}), children: tidy(converted) };
    }
    if (!title) return null;
    const role = item.id === CLOSE_WINDOW && !closeThroughHost ? "close" : ITEM_ROLES[item.id];
    if (role) return take() ? { title, role, ...shortcutOf(item) } : null;
    const choice = appMenuChoice(item.id);
    if (!choice) return take() ? { title, enabled: false } : null;
    if (choice.kind !== "command") {
      return take() ? { title, command: MENU_PICK, arg: item.id, enabled: item.enabled !== false, ...shortcutOf(item) } : null;
    }
    const { command, arg } = choice;
    if (!COMMAND.test(command) || (arg !== null && byteLength(arg) > MAX_ARGUMENT_BYTES)) return null;
    if (byteLength(item.id) > MAX_STATE_ID_BYTES || control.test(item.id) || !take()) return null;
    const fixedCheck = item.checked === true;
    const shown = nativeMenuTitle(flags.titles[item.id] ?? "") || title;
    return {
      title: shown,
      ...(shown !== title ? { defaultTitle: title } : {}),
      command,
      ...(arg !== null ? { arg } : {}),
      id: item.id,
      enabled: !disabled.has(item.id) && !disabled.has(command),
      checked: fixedCheck || checked.has(item.id),
      ...(fixedCheck ? { fixedCheck } : {}),
      ...shortcutOf(item),
    };
  };

  return items.map((item) => convert(item, 1)).filter((item): item is NativeMenuItem => !!item && !!item.children);
}

export function utilityMenuSpec({ appName = "Ardia", closeThroughHost = false }: NativeMenuOptions = {}): NativeMenuItem[] {
  const close: NativeMenuItem = closeThroughHost
    ? { title: "Close Window", command: MENU_PICK, arg: CLOSE_WINDOW, ...MAC_SHORTCUTS[CLOSE_WINDOW] }
    : { title: "Close Window", role: "close", ...MAC_SHORTCUTS[CLOSE_WINDOW] };
  const edit = EDIT_ITEMS.map((item): NativeMenuItem => ({ title: item.title, role: item.action, ...MAC_SHORTCUTS[item.id] }));
  return [
    { title: appName, children: [{ title: `About ${appName}`, role: "about" }, ...appMenuStandardItems(appName), { title: `Quit ${appName}`, command: "quit", ...MAC_SHORTCUTS[QUIT] }] },
    { title: "File", children: [close] },
    { title: "Edit", children: [...edit.slice(0, 2), { separator: true }, ...edit.slice(2)] },
    { title: "Window", role: "windowMenu", children: [{ title: "Minimize", role: "minimize", ...MAC_SHORTCUTS["window:minimize"] }, { title: "Zoom", role: "zoom" }] },
    { title: "Help", role: "helpMenu", children: [] },
  ];
}

export type NativeMenuBarDeps = {
  supports(method: string): boolean;
  invoke(method: string, args: Record<string, unknown>): Promise<unknown>;
  build(): { items: readonly MenuItem[]; flags: MenuFlags };
  options?: NativeMenuOptions;
  subscribe(changed: () => void): () => void;
  timeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  report?(error: unknown): void;
};

export function createNativeMenuBar(deps: NativeMenuBarDeps) {
  if (!deps.supports(SET_MAIN_MENU_METHOD)) return { stop: () => {}, flush: () => {}, active: false };
  const followsState = deps.supports(SET_MENU_STATE_METHOD);
  let sentKey = "";
  let timer: unknown = null;
  let inFlight = false;
  let again = false;
  let stopped = false;

  const flush = (forced = false) => {
    timer = null;
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    const { items, flags } = deps.build();
    const spec = nativeMenuSpec(items, flags, deps.options);
    const key = JSON.stringify([followsState ? nativeMenuSpec(items, NO_MENU_FLAGS, deps.options) : spec]);
    if (key === sentKey && !forced) return;
    sentKey = key;
    inFlight = true;
    void Promise.resolve()
      .then(() => deps.invoke(SET_MAIN_MENU_METHOD, { items: spec }))
      .catch((error) => {
        sentKey = "";
        deps.report?.(error);
      })
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  };

  const schedule = () => {
    if (timer !== null || stopped) return;
    timer = deps.timeout(() => flush(), NATIVE_MENU_SYNC_MS);
  };

  const stopChanges = deps.subscribe(schedule);
  flush(true);

  return {
    active: true,
    flush: () => flush(true),
    stop() {
      stopped = true;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
      stopChanges();
    },
  };
}

export type MenuPickEvent = { command?: unknown; arg?: unknown; windowId?: unknown } | null;

export function menuPickFor(windowId: string, event: MenuPickEvent): string | null {
  if (event?.command !== MENU_PICK || typeof event.arg !== "string") return null;
  return event.windowId === undefined || event.windowId === null || event.windowId === windowId ? event.arg : null;
}
