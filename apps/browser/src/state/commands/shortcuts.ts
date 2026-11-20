import type { ShortcutModifier } from "../../platform/commands";
import { isModifier, ordered } from "./modifiers";

import { formatShortcut as formatKeys, storedModifiers } from "./keyNotation";
import { isMouseKey, withMouseButton } from "./mouseButtons";

export { parseShortcut } from "./keyNotation";

export type Shortcut = { key: string; modifiers: ShortcutModifier[] };
export type ShortcutSource = { id: string; keys: Shortcut[]; fixed?: boolean };
export type ShortcutOverrides = Record<string, string[]>;
export type ResolvedShortcuts = {
  bindings: ReadonlyMap<string, Shortcut[]>;
  mouse: ReadonlyMap<string, Shortcut>;
  defaultsOf(id: string): Shortcut[];
  conflictsOf(id: string): string[];
  holdersOf(shortcut: Shortcut): string[];
};

type ModifierReading = typeof storedModifiers;

const LAYOUT_CODES_OF_FUNCTION_KEYS: Record<string, string> = {
  "\u001c": "\uf702",
  "\u001d": "\uf703",
  "\u001e": "\uf700",
  "\u001f": "\uf701",
  "\u0001": "\uf729",
  "\u0004": "\uf72b",
  "\u000b": "\uf72c",
  "\u000c": "\uf72d",
  "\u007f": "\uf728",
};

export const isNavigationOrFunctionKey = (key: string) => {
  const code = key.charCodeAt(0);
  return Array.from(key).length === 1 && code >= 0xf700 && code <= 0xf8ff;
};

function recordedAsLayoutCode(stored: readonly string[]): string[] {
  const functionKey = LAYOUT_CODES_OF_FUNCTION_KEYS[stored[0] ?? ""];
  if (!functionKey || !stored.includes("function")) return [...stored];
  return [functionKey, ...stored.slice(1).filter((m) => m !== "function")];
}

export function formatShortcut(shortcut: Shortcut): string {
  if (!isMouseKey(shortcut.key)) return formatKeys(shortcut);
  const modifierText = shortcut.modifiers.length ? formatKeys({ key: "a", modifiers: shortcut.modifiers }).slice(0, -1) : "";
  return withMouseButton(modifierText, shortcut.key);
}

export const isMouseShortcut = (shortcut: Shortcut) => isMouseKey(shortcut.key);

export function storedShortcut(raw: readonly string[], read: ModifierReading = storedModifiers): Shortcut {
  const stored = recordedAsLayoutCode(raw);
  const key = stored[0] ?? "";
  const modifiers = read(stored.slice(1).filter(isModifier));
  const shifted = Array.from(key).length === 1 && key !== key.toLowerCase();
  return { key: shifted ? key.toLowerCase() : key, modifiers: ordered(shifted ? [...modifiers, "shift"] : modifiers) };
}

export function comboKey({ key, modifiers }: Shortcut): string {
  const shifted = key !== key.toLowerCase() ? ["shift"] : [];
  return `${ordered([...modifiers, ...shifted]).join("+")}|${key.toLowerCase()}`;
}

export const sameShortcut = (a: Shortcut, b: Shortcut) => comboKey(a) === comboKey(b);

export function resolveShortcuts(sources: readonly ShortcutSource[], overrides: ShortcutOverrides, read: ModifierReading = storedModifiers, mouseOverrides: ShortcutOverrides = {}): ResolvedShortcuts {
  const rebindable = new Set(sources.filter((s) => !s.fixed).map((s) => s.id));
  const taken = new Set<string>();
  for (const [id, stored] of Object.entries(overrides)) {
    if (rebindable.has(id) && stored[0]) taken.add(comboKey(storedShortcut(stored, read)));
  }
  const bindings = new Map<string, Shortcut[]>();
  const holders = new Map<string, string[]>();
  for (const source of sources) {
    const stored = source.fixed ? undefined : overrides[source.id];
    const candidates = stored ? [storedShortcut(stored, read)] : source.keys.filter((k) => source.fixed || !taken.has(comboKey(k)));
    const seen = new Set<string>();
    const keys = candidates.filter((k) => k.key && !seen.has(comboKey(k)) && seen.add(comboKey(k)));
    bindings.set(source.id, keys);
    for (const combo of seen) holders.set(combo, [...(holders.get(combo) ?? []), source.id]);
  }
  const mouse = new Map<string, Shortcut>();
  for (const id of Object.keys(mouseOverrides)) {
    const stored = mouseOverrides[id];
    if (!rebindable.has(id) || !stored || !isMouseKey(stored[0] ?? "")) continue;
    const recorded = storedShortcut(stored, read);
    const button = { key: recorded.key, modifiers: recorded.modifiers.filter((m) => m !== "function") };
    mouse.set(id, button);
    holders.set(comboKey(button), [...(holders.get(comboKey(button)) ?? []), id]);
  }
  const defaults = new Map(sources.map((source) => [source.id, source.keys]));
  const heldBy = (id: string) => [...(bindings.get(id) ?? []), ...(mouse.has(id) ? [mouse.get(id)!] : [])];
  return {
    bindings,
    mouse,
    defaultsOf: (id) => defaults.get(id) ?? [],
    holdersOf: (shortcut) => holders.get(comboKey(shortcut)) ?? [],
    conflictsOf: (id) => [...new Set(heldBy(id).flatMap((k) => holders.get(comboKey(k)) ?? []))].filter((other) => other !== id),
  };
}
