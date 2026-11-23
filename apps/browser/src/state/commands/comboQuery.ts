import type { ShortcutModifier } from "../../platform/commands";
import { COMBO_MODIFIER_WORDS, COMBO_PLATFORM_KEYS } from "./comboWords";
import { storedModifiers } from "./keyNotation";
import { GLYPH_KEYS, MODIFIER_GLYPHS } from "./macGlyphs";
import { FIRST_FUNCTION_KEY, ordered } from "./modifiers";
import { sameShortcut, type Shortcut } from "./shortcuts";

type ComboWords = { modifiers: Readonly<Record<string, ShortcutModifier>>; keys: Readonly<Record<string, string>>; stored: (modifiers: readonly ShortcutModifier[]) => ShortcutModifier[] };

const LAST_COMBO_FUNCTION_KEY = 24;
const SEPARATORS = /[\s+-]+/;
const TAIL_KEYS = new Set(["+", "-"]);
const GLYPH_MODIFIERS: ReadonlyMap<string, ShortcutModifier> = new Map(Object.entries(MODIFIER_GLYPHS).map(([modifier, glyph]) => [glyph, modifier as ShortcutModifier]));
const GLYPH_SPLIT = new RegExp(`(${[...GLYPH_MODIFIERS.keys(), ...Object.keys(GLYPH_KEYS).filter((g) => Array.from(g).length === 1)].join("|")})`, "gu");

const KEY_WORDS: Readonly<Record<string, string>> = {
  tab: "\t",
  return: "\r",
  enter: "\r",
  esc: "\u001b",
  escape: "\u001b",
  space: " ",
  spacebar: " ",
  backspace: "\u0008",
  forwarddelete: "",
  fwddel: "",
  up: "",
  down: "",
  left: "",
  right: "",
  home: "",
  end: "",
  pageup: "",
  pgup: "",
  pagedown: "",
  pgdn: "",
  comma: ",",
  period: ".",
  dot: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backtick: "`",
  grave: "`",
  minus: "-",
  plus: "+",
  equal: "=",
  equals: "=",
};

const SAME_KEYS: Readonly<Record<string, string>> = { "\u007f": "\u0008", "\u0003": "\r" };

const PLATFORM_COMBO_WORDS: ComboWords = { modifiers: COMBO_MODIFIER_WORDS, keys: COMBO_PLATFORM_KEYS, stored: storedModifiers };

function modifierOf(token: string, words: ComboWords): ShortcutModifier | undefined {
  const glyph = GLYPH_MODIFIERS.get(token);
  if (glyph) return glyph;
  const lower = token.toLowerCase();
  return Object.hasOwn(words.modifiers, lower) ? words.modifiers[lower] : undefined;
}

function keyOf(token: string, words: ComboWords): string | undefined {
  const lower = token.toLowerCase();
  if (Object.hasOwn(words.keys, lower)) return words.keys[lower];
  if (Object.hasOwn(KEY_WORDS, lower)) return KEY_WORDS[lower];
  if (Object.hasOwn(GLYPH_KEYS, token)) return GLYPH_KEYS[token];
  const functionKey = /^f(\d{1,2})$/.exec(lower);
  if (functionKey) {
    const n = Number(functionKey[1]);
    return n >= 1 && n <= LAST_COMBO_FUNCTION_KEY ? String.fromCharCode(FIRST_FUNCTION_KEY + n - 1) : undefined;
  }
  return Array.from(token).length === 1 ? lower : undefined;
}

function splitTail(text: string): { body: string; tail: string | null } {
  const last = text.at(-1) ?? "";
  if (!TAIL_KEYS.has(last)) return { body: text, tail: null };
  const before = text.slice(0, -1);
  const prev = before.at(-1);
  if (prev === undefined || /\s/.test(prev) || TAIL_KEYS.has(prev) || GLYPH_MODIFIERS.has(prev)) return { body: before, tail: last };
  return { body: text, tail: null };
}

export function parseCombo(text: string, words: ComboWords = PLATFORM_COMBO_WORDS): Shortcut | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const { body, tail } = splitTail(trimmed);
  if (!tail && TAIL_KEYS.has(body.at(-1) ?? "")) return null;
  const tokens = body.replace(GLYPH_SPLIT, " $1 ").split(SEPARATORS).filter(Boolean);
  const modifiers: ShortcutModifier[] = [];
  const keys: string[] = tail ? [tail] : [];
  for (const token of tokens) {
    const modifier = modifierOf(token, words);
    if (modifier) {
      modifiers.push(modifier);
      continue;
    }
    const key = keyOf(token, words);
    if (key === undefined) return null;
    keys.push(key);
  }
  if (keys.length !== 1 || !modifiers.length) return null;
  const stored = ordered(words.stored(modifiers));
  return stored.length ? { key: keys[0]!, modifiers: stored } : null;
}

const sameKey = ({ key, modifiers }: Shortcut): Shortcut => ({ key: Object.hasOwn(SAME_KEYS, key) ? SAME_KEYS[key]! : key, modifiers });

export const bindsCombo = (binding: Shortcut | undefined, combo: Shortcut): boolean => !!binding?.key && sameShortcut(sameKey(binding), sameKey(combo));

export function commandsBoundTo<T extends { id: string }>(combo: Shortcut, items: readonly T[], bindingsOf: (id: string) => readonly Shortcut[] | undefined): T[] {
  return items.filter((item) => (bindingsOf(item.id) ?? []).some((binding) => bindsCombo(binding, combo)));
}
