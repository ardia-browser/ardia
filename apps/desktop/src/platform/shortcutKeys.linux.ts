import { DEFAULT_KEYS as DESKTOP_DEFAULT_KEYS } from "./shortcutKeys.desktop.ts";

export { COMMAND_PRESSED, CONTROL_PRESSED, EDITS_TEXT, MODIFIER_FLAGS, MODIFIER_KEYS, SHORTCUTS_SHOWN_AS_GLYPHS } from "./shortcutKeys.desktop.ts";

export const DEFAULT_KEYS: Readonly<Record<string, readonly string[]>> = {
  ...DESKTOP_DEFAULT_KEYS,
  showHiddenElements: [],
};
