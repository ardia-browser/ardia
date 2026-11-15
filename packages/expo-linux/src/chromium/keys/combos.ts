export const Modifier = { Control: 1, Option: 2, Shift: 4, Command: 8, Function: 16 } as const;

export type Combo = { key: string; modifiers: number };
export type KeyPress = { code: string; fixed: string; base: string; shifted: string; modifiers: number; meta: boolean; altGraph: boolean };

export const MODIFIER_ORDER = [Modifier.Control, Modifier.Option, Modifier.Shift, Modifier.Command, Modifier.Function];
const MODIFIER_NAMES: Record<number, string> = { [Modifier.Control]: "control", [Modifier.Option]: "option", [Modifier.Shift]: "shift", [Modifier.Command]: "command", [Modifier.Function]: "function" };

export const FUNCTION_KEY_F1 = 0xf704;
export const LEFT = "";
export const RIGHT = "";
export const ESCAPE = "\u001b";

const NAMED_KEYS: Record<string, string> = {
  plus: "+", left: LEFT, right: RIGHT, up: "", down: "", pageup: "", pagedown: "", home: "", end: "",
  delete: "", insert: "", backspace: "\b", tab: "\t", enter: "\r", escape: ESCAPE, space: " ",
};

const CODE_KEYS: Record<string, string> = {
  ArrowLeft: LEFT, ArrowRight: RIGHT, ArrowUp: "", ArrowDown: "", PageUp: "", PageDown: "", Home: "", End: "",
  Delete: "", Insert: "", Backspace: "\b", Tab: "\t", Enter: "\r", NumpadEnter: "\r", Escape: ESCAPE, Space: " ",
  NumpadAdd: "+", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".",
};

const US_LAYOUT: Record<string, [string, string]> = {
  Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"], Semicolon: [";", ":"],
  Quote: ["'", '"'], Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"], Backquote: ["`", "~"], IntlBackslash: ["\\", "|"],
  Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"], Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"],
  Digit8: ["8", "*"], Digit9: ["9", "("], Digit0: ["0", ")"],
};

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "NumLock", "ScrollLock", "OSLeft", "OSRight", "Fn", "FnLock"]);
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "Super", "Hyper", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn", "Process", "Dead", "Unidentified"]);

export const isModifierPress = (code: string, key: string) => MODIFIER_CODES.has(code) || MODIFIER_KEYS.has(key);

export function modifierOfKey(key: string): number {
  if (key === "Shift") return Modifier.Shift;
  if (key === "Control") return Modifier.Control;
  if (key === "Alt") return Modifier.Option;
  return 0;
}

export const modifierName = (modifier: number) => MODIFIER_NAMES[modifier] ?? "";

export function isPrintableKey(key: string): boolean {
  const code = key.codePointAt(0) ?? 0;
  return key.length > 0 && code >= 0x20 && code !== 0x7f && (code < 0xf700 || code > 0xf8ff);
}

export function isFunctionKey(key: string): boolean {
  const code = key.codePointAt(0) ?? 0;
  return key.length === 1 && code >= FUNCTION_KEY_F1 && code < FUNCTION_KEY_F1 + 24;
}

function keyNamed(name: string): string {
  if (name.length === 1) return name.toLowerCase();
  if (NAMED_KEYS[name]) return NAMED_KEYS[name]!;
  const fn = /^f(\d{1,2})$/.exec(name);
  if (fn) {
    const number = Number(fn[1]);
    if (number >= 1 && number <= 24) return String.fromCharCode(FUNCTION_KEY_F1 + number - 1);
  }
  return "";
}

const MODIFIERS_NAMED: Record<string, number> = {
  ctrl: Modifier.Control, control: Modifier.Control, alt: Modifier.Option, option: Modifier.Option, shift: Modifier.Shift,
  cmd: Modifier.Command, command: Modifier.Command, fn: Modifier.Function, function: Modifier.Function,
};

export const modifierNamed = (name: string): number | undefined => MODIFIERS_NAMED[name];

export function parseCombo(text: string): Combo | null {
  if (!text || text === "none") return null;
  const parts = text.split("+");
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const modifier = modifierNamed(part);
    if (!modifier) return null;
    modifiers |= modifier;
  }
  const key = keyNamed(parts[parts.length - 1]!);
  return key ? { key, modifiers } : null;
}

export const parseCombos = (list: string): (Combo | null)[] => (list ? list.split("|").map(parseCombo) : []);

export const sameCombo = (a: Combo | null, b: Combo | null) => !!a && !!b && a.key === b.key && a.modifiers === b.modifiers;

export function linuxComboFromStored(stored: Combo | null): Combo | null {
  if (!stored) return null;
  let modifiers = stored.modifiers & (Modifier.Control | Modifier.Option | Modifier.Shift);
  if (stored.modifiers & Modifier.Command) modifiers |= Modifier.Control;
  const held = (modifiers & (Modifier.Control | Modifier.Option)) !== 0;
  if (!held && isPrintableKey(stored.key)) return null;
  return { key: stored.key, modifiers };
}

export function storedCombo(stored: string[]): Combo | null {
  const key = stored[0];
  if (!key || [...key].length !== 1) return null;
  const lower = key.toLowerCase();
  let modifiers = lower !== key ? Modifier.Shift : 0;
  for (const name of stored.slice(1)) modifiers |= modifierNamed(name) ?? 0;
  return { key: lower, modifiers };
}

export function storedForm(combo: Combo): string[] {
  return [combo.key, ...MODIFIER_ORDER.filter((modifier) => combo.modifiers & modifier).map(modifierName)];
}

export type KeyInput = { type: string; key: string; code: string; shift: boolean; control: boolean; alt: boolean; meta: boolean; isAutoRepeat?: boolean; modifiers?: string[] };

function fixedKeyOf(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1]!;
  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn) return String.fromCharCode(FUNCTION_KEY_F1 + Number(fn[1]) - 1);
  return CODE_KEYS[code] ?? "";
}

export function readKeyPress(input: KeyInput): KeyPress {
  let modifiers = 0;
  if (input.control) modifiers |= Modifier.Control;
  if (input.alt) modifiers |= Modifier.Option;
  if (input.shift) modifiers |= Modifier.Shift;
  const fixed = fixedKeyOf(input.code);
  const special = fixed !== "" && !/^(Key[A-Z]|Digit\d)$/.test(input.code);
  let base = "";
  let shifted = "";
  if (!special) {
    const typed = [...input.key].length === 1 ? input.key : "";
    const us = US_LAYOUT[input.code];
    if (input.shift) {
      shifted = typed.toLowerCase();
      base = us?.[0] ?? (typed ? typed.toLowerCase() : "");
    } else {
      base = typed.toLowerCase();
      shifted = us?.[1] ?? "";
    }
  }
  const altGraph = input.modifiers?.includes("altgraph") === true || input.key === "AltGraph";
  return { code: input.code, fixed, base, shifted, modifiers, meta: input.meta, altGraph };
}

const isShiftedSymbol = (key: string) => isPrintableKey(key) && key.toUpperCase() === key.toLowerCase();

export function matches(combo: Combo, press: KeyPress): boolean {
  if (combo.modifiers === press.modifiers && (combo.key === press.fixed || (!!press.base && combo.key === press.base))) return true;
  if (!(press.modifiers & Modifier.Shift) || !press.shifted || combo.key !== press.shifted) return false;
  if (combo.modifiers === press.modifiers) return true;
  return isShiftedSymbol(combo.key) && (combo.modifiers | Modifier.Shift) === press.modifiers;
}

export const recordedKey = (press: KeyPress) => press.fixed || press.base;

export function keyLabel(key: string): string {
  if (isFunctionKey(key)) return `F${key.charCodeAt(0) - FUNCTION_KEY_F1 + 1}`;
  const labels: Record<string, string> = {
    [LEFT]: "Left", [RIGHT]: "Right", "": "Up", "": "Down", "": "PgUp", "": "PgDn", "": "Home", "": "End",
    "": "Del", "": "Ins", "\b": "Backspace", "\u007f": "Backspace", "\t": "Tab", "\r": "Enter", "\u0003": "Enter", [ESCAPE]: "Esc", " ": "Space", "+": "Plus",
  };
  if (labels[key]) return labels[key]!;
  return isPrintableKey(key) ? key.toUpperCase() : "";
}

export function electronAccelerator(combo: Combo): string | undefined {
  const label = keyLabel(combo.key);
  if (!label) return undefined;
  const key = ({ Left: "Left", Right: "Right", Up: "Up", Down: "Down", PgUp: "PageUp", PgDn: "PageDown", Del: "Delete", Ins: "Insert", Esc: "Escape", Enter: "Return" } as Record<string, string>)[label] ?? label;
  const parts: string[] = [];
  if (combo.modifiers & (Modifier.Control | Modifier.Command)) parts.push("Ctrl");
  if (combo.modifiers & Modifier.Option) parts.push("Alt");
  if (combo.modifiers & Modifier.Shift) parts.push("Shift");
  return [...parts, key].join("+");
}
