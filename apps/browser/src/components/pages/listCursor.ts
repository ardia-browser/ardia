import { COMMAND_KEY, commandHeld } from "../../state/commands/keyNotation";
import { allRows, movedCursor, toggledCursor, type RowSelection } from "../../state/history/historySelection";

export type ListKey = { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };

export type ListCommand = "down" | "up" | "extendDown" | "extendUp" | "toggle" | "open" | "menu" | "all" | "remove" | "clear";

export const ROW_MENU_KEYS = [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }];

export const isRowMenuKey = ({ key, shiftKey }: ListKey) => key === "ContextMenu" || (key === "F10" && !!shiftKey);

export function keepActivationKeys(e: { nativeEvent: { key?: string }; stopPropagation: () => void }) {
  if (e.nativeEvent.key === "Enter" || e.nativeEvent.key === " ") e.stopPropagation();
}

export const LIST_KEYS = [
  { key: "ArrowDown" },
  { key: "ArrowUp" },
  { key: "ArrowDown", shiftKey: true },
  { key: "ArrowUp", shiftKey: true },
  { key: " " },
  { key: "Enter" },
  { key: "a", [COMMAND_KEY]: true },
  { key: "Backspace" },
  { key: "Delete" },
  ...ROW_MENU_KEYS,
];

export const LIST_KEYS_WITH_ESCAPE = [...LIST_KEYS, { key: "Escape" }];

export function listCommand(e: ListKey, selecting: boolean): ListCommand | null {
  const { key, shiftKey } = e;
  if (isRowMenuKey(e)) return "menu";
  if (key === "ArrowDown") return shiftKey ? "extendDown" : "down";
  if (key === "ArrowUp") return shiftKey ? "extendUp" : "up";
  if (key === " ") return "toggle";
  if (key === "Enter") return "open";
  if (key === "a" && commandHeld(e)) return "all";
  if (key === "Backspace" || key === "Delete") return "remove";
  if (key === "Escape" && selecting) return "clear";
  return null;
}

export function selectionAfter(command: ListCommand, keys: readonly string[], s: RowSelection): RowSelection {
  switch (command) {
    case "down":
    case "up":
    case "extendDown":
    case "extendUp":
      return movedCursor(keys, s, command === "down" || command === "extendDown" ? 1 : -1, command === "extendDown" || command === "extendUp");
    case "toggle":
      return toggledCursor(keys, s);
    case "all":
      return allRows(keys, s);
    case "clear":
      return s.selected.size ? { ...s, selected: new Set() } : s;
    default:
      return s;
  }
}

export const cursorRow = (keys: readonly string[], s: RowSelection) => (s.cursor && keys.includes(s.cursor) ? s.cursor : null);

export const startedCursor = (keys: readonly string[], s: RowSelection): RowSelection => (cursorRow(keys, s) || !keys.length ? s : { ...s, anchor: keys[0]!, cursor: keys[0]! });

export const enteredCursor = (keys: readonly string[], s: RowSelection): RowSelection => movedCursor(keys, { ...s, cursor: null }, 1, false);

export const menuRows = (keys: readonly string[], s: RowSelection, row: string): string[] => (s.selected.has(row) ? keys.filter((key) => s.selected.has(key)) : [row]);

export function revealOffset(top: number, height: number, scrollY: number, viewport: number): number | null {
  if (top < scrollY) return Math.max(0, top);
  if (top + height > scrollY + viewport) return top + height - viewport;
  return null;
}
