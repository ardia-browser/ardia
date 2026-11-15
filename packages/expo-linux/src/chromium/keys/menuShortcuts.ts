import { Modifier, linuxComboFromStored, storedCombo } from "../../../../../apps/browser/linux/src/menus/keys";
import { menuStore } from "../../../../../apps/browser/linux/src/menus/store";
import { pressesFor } from "./keyMap";

export type MenuShortcut = { code: string; ctrl: boolean; shift: boolean; alt: boolean };
type MenuItem = { key?: string; modifiers?: string[]; children?: MenuItem[]; shortcut?: MenuShortcut; [field: string]: unknown };

export function linuxShortcutOf(key: string, modifiers: string[]): MenuShortcut | null {
  const stored = storedCombo([key, ...modifiers]);
  if (!stored) return null;
  const combo = menuStore.linuxComboForMac(stored) ?? linuxComboFromStored(stored);
  const press = combo ? pressesFor(combo)[0] : undefined;
  if (!press) return null;
  return {
    code: press.code,
    ctrl: (press.modifiers & (Modifier.Control | Modifier.Command)) !== 0,
    shift: (press.modifiers & Modifier.Shift) !== 0,
    alt: (press.modifiers & Modifier.Option) !== 0,
  };
}

export function withLinuxShortcuts(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item: MenuItem) => {
    if (!item || typeof item !== "object") return item;
    const mapped: MenuItem = { ...item };
    if (Array.isArray(item.children)) mapped.children = withLinuxShortcuts(item.children) as MenuItem[];
    if (typeof item.key === "string" && item.key) {
      const shortcut = linuxShortcutOf(item.key, Array.isArray(item.modifiers) ? item.modifiers : []);
      if (shortcut) mapped.shortcut = shortcut;
    }
    return mapped;
  });
}
