import type { ShortcutModifier } from "@ardia-real/shell";

export const MODIFIER_FLAGS: Readonly<Record<ShortcutModifier, number>> = { command: 16, control: 4, option: 8, shift: 2, function: 0 };

export const MODIFIER_KEYS: Readonly<Record<string, ShortcutModifier>> = { Meta: "command", Control: "control", Alt: "option", Shift: "shift" };

export const COMMAND_PRESSED = (event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">) => event.metaKey;

export const CONTROL_PRESSED = (event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">) => event.ctrlKey;

export const DEFAULT_KEYS: Readonly<Record<string, readonly string[]>> = {};

export const SHORTCUTS_SHOWN_AS_GLYPHS = true;

const CARET_KEYS: ReadonlySet<number> = new Set([8, 33, 34, 35, 36, 37, 38, 39, 40, 46]);

export const EDITS_TEXT = (keyCode: number, modifiers: number): boolean =>
  CARET_KEYS.has(keyCode) && !(modifiers & MODIFIER_FLAGS.control) && !!(modifiers & (MODIFIER_FLAGS.command | MODIFIER_FLAGS.option));
