import { isMouseShortcut, sameShortcut, storedShortcut, type Shortcut } from "../commands/shortcuts";
import { resolvedShortcuts, type ShortcutState } from "../commands/commandShortcuts";
import { useBrowser } from "../browser/store";
import { setMouseShortcut, setShortcutOverride } from "./actions";

export const NO_SHORTCUT: Shortcut = { key: "", modifiers: [] };

export type RecordedChange = "changed" | "cleared" | "mouse";

type Bindable = { id: string; remappable: boolean; mouseBindable?: boolean };

export function applyRecordedShortcut(
  item: Bindable,
  combo: Shortcut | null | undefined,
  now: ShortcutState = useBrowser.getState(),
): RecordedChange | null {
  if (!combo) return null;
  const resolved = resolvedShortcuts(now);
  const saved = now.settings.shortcuts[item.id];
  if (isMouseShortcut(combo)) {
    if (!item.remappable || !item.mouseBindable) return null;
    const current = resolved.mouse.get(item.id);
    if (current && sameShortcut(current, combo)) return null;
    setMouseShortcut(item.id, combo);
    return "mouse";
  }
  const primary = resolved.defaultsOf(item.id)[0] ?? NO_SHORTCUT;
  const current = resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT;
  if (saved?.[0] ? sameShortcut(combo, storedShortcut(saved)) : !saved && sameShortcut(combo, primary) && sameShortcut(current, primary)) return null;
  const defaultIsFree = resolved.holdersOf(primary).every((holder) => holder === item.id);
  setShortcutOverride(item.id, sameShortcut(combo, primary) && defaultIsFree ? null : combo);
  return "changed";
}

export function clearShortcut(item: { id: string }, now: ShortcutState = useBrowser.getState()): RecordedChange | null {
  const resolved = resolvedShortcuts(now);
  if (!resolved.bindings.get(item.id)?.length) return null;
  setShortcutOverride(item.id, resolved.defaultsOf(item.id).length ? NO_SHORTCUT : null);
  return "cleared";
}
