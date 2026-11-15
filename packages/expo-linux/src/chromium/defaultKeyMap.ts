import { COMMAND_ROWS, Row } from "../../../../apps/browser/linux/src/menus/commandTable";
import { callMainSync, mainModules } from "../bridge";

export type KeyMapEntry = { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; command: string; arg?: string; pageFirst?: boolean };

const SKIPPED = Row.NativeAction | Row.DebugOnly;

const NAMED_CODES: Record<string, string> = {
  ",": "Comma", "-": "Minus", ".": "Period", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "/": "Slash", ";": "Semicolon", "'": "Quote", "`": "Backquote",
  delete: "Delete", escape: "Escape", home: "Home", end: "End", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
  pageup: "PageUp", pagedown: "PageDown", tab: "Tab", enter: "Enter", space: "Space", backspace: "Backspace",
};

const SHIFTED: Record<string, string> = { "{": "[", "}": "]", plus: "=" };

function entryFor(combo: string, command: string, arg: string | null): KeyMapEntry | null {
  const parts = combo.toLowerCase().split("+").filter(Boolean);
  const key = parts.pop();
  if (!key || key === "none") return null;
  const mods = new Set(parts);
  const shiftedBase = SHIFTED[key];
  const base = shiftedBase ?? key;
  const code = /^[a-z]$/.test(base) ? `Key${base.toUpperCase()}` : /^[0-9]$/.test(base) ? `Digit${base}` : /^f([1-9]|1[0-9]|2[0-4])$/.test(base) ? base.toUpperCase() : NAMED_CODES[base];
  if (!code) return null;
  const ctrl = mods.has("ctrl");
  const alt = mods.has("alt");
  const meta = mods.has("super") || mods.has("meta");
  const entry: KeyMapEntry = { code, ctrl, shift: mods.has("shift") || !!shiftedBase, alt, meta, command, pageFirst: !ctrl && !alt && !meta };
  if (arg !== null) entry.arg = arg;
  return entry;
}

export function defaultKeyMap(): KeyMapEntry[] {
  const entries: KeyMapEntry[] = [];
  for (const row of COMMAND_ROWS) {
    if ((row.flags ?? 0) & SKIPPED || row.id.startsWith("std:") || !row.linux) continue;
    const colon = row.id.indexOf(":");
    const command = colon >= 0 ? row.id.slice(0, colon) : row.id;
    const arg = colon >= 0 ? row.id.slice(colon + 1) : null;
    for (const combo of row.linux.split("|")) {
      const entry = entryFor(combo, command, arg);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

export function pushDefaultKeyMap(): number | undefined {
  if (!mainModules().ArdiaMenus?.sync.includes("setKeyMap")) return undefined;
  return callMainSync<number>("ArdiaMenus", "setKeyMap", defaultKeyMap());
}
