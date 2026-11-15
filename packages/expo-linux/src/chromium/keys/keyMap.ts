import { Row } from "./commandTable";
import { Modifier, matches, readKeyPress, type Combo, type KeyInput } from "./combos";
import type { CommandEntry } from "./store";

export type KeyMapEntry = { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; command: string; arg?: string; pageFirst?: boolean; uiOnly?: boolean };

export type KeyModes = {
  recording: boolean;
  switcherHeld: number;
  escapeCaptured: boolean;
  textInputFocused: boolean;
  undoReopensClosedTab: boolean;
  reopenClosedTabEnabled: boolean;
};

export const INTERNAL_PREFIX = "linux:";
export const SWITCHER_KEY = `${INTERNAL_PREFIX}switcherKey`;
export const DRAG_ESCAPE = `${INTERNAL_PREFIX}dragEscape`;
export const QUIT = `${INTERNAL_PREFIX}quit`;

const US_TYPED: Record<string, [string, string]> = {
  Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"], Semicolon: [";", ":"],
  Quote: ["'", '"'], Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"], Backquote: ["`", "~"],
  Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"], Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"],
  Digit8: ["8", "*"], Digit9: ["9", "("], Digit0: ["0", ")"],
  NumpadAdd: ["+", "+"], NumpadSubtract: ["-", "-"], NumpadMultiply: ["*", "*"], NumpadDivide: ["/", "/"], NumpadDecimal: [".", "."],
  Space: [" ", " "],
};

const NAMED_CODES = [
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Delete", "Insert", "Backspace", "Tab", "Enter", "NumpadEnter", "Escape",
];

const CODES: string[] = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`),
  ..."0123456789".split("").map((digit) => `Numpad${digit}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Object.keys(US_TYPED),
  ...NAMED_CODES,
];

type Press = { code: string; modifiers: number };

function typedOn(code: string, shift: boolean): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return shift ? letter[1]! : letter[1]!.toLowerCase();
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return numpad[1]!;
  const typed = US_TYPED[code];
  if (typed) return typed[shift ? 1 : 0];
  return code;
}

function inputOf(code: string, modifiers: number): KeyInput {
  const shift = (modifiers & Modifier.Shift) !== 0;
  return { type: "keyDown", code, key: typedOn(code, shift), shift, control: (modifiers & Modifier.Control) !== 0, alt: (modifiers & Modifier.Option) !== 0, meta: false };
}

export function pressesFor(combo: Combo): Press[] {
  const presses: Press[] = [];
  const held = combo.modifiers & ~Modifier.Command & ~Modifier.Function;
  for (const modifiers of [held, held | Modifier.Shift]) {
    for (const code of CODES) {
      if (matches(combo, readKeyPress(inputOf(code, modifiers)))) presses.push({ code, modifiers });
    }
  }
  return presses;
}

const entryOf = (press: Press, command: string, arg: string | null, extra: Partial<KeyMapEntry> = {}): KeyMapEntry => {
  const ctrl = (press.modifiers & (Modifier.Control | Modifier.Command)) !== 0;
  const alt = (press.modifiers & Modifier.Option) !== 0;
  const entry: KeyMapEntry = { code: press.code, ctrl, shift: (press.modifiers & Modifier.Shift) !== 0, alt, meta: false, command, pageFirst: !ctrl && !alt, ...extra };
  if (arg !== null) entry.arg = arg;
  return entry;
};

const keyOf = (entry: KeyMapEntry) => `${entry.code}:${entry.ctrl ? 1 : 0}${entry.shift ? 1 : 0}${entry.alt ? 1 : 0}${entry.meta ? 1 : 0}`;

export function heldModifiersOf(combo: Combo): number {
  const held = combo.modifiers & (Modifier.Control | Modifier.Option | Modifier.Command);
  return held || combo.modifiers & Modifier.Shift;
}

export function buildKeyMap(entries: CommandEntry[], usable: (entry: CommandEntry) => boolean, modes: KeyModes): KeyMapEntry[] {
  if (modes.recording) return [];
  const map = new Map<string, KeyMapEntry>();
  const put = (entry: KeyMapEntry) => {
    const key = keyOf(entry);
    if (!map.has(key)) map.set(key, entry);
  };
  if (modes.switcherHeld) {
    const held = modes.switcherHeld;
    for (const [code, key] of [["Escape", "escape"], ["ArrowRight", "next"], ["ArrowLeft", "previous"]] as const) {
      for (const modifiers of [0, held, held | Modifier.Shift]) put(entryOf({ code, modifiers }, SWITCHER_KEY, key, { pageFirst: false }));
    }
  }
  if (modes.escapeCaptured) put(entryOf({ code: "Escape", modifiers: 0 }, DRAG_ESCAPE, null, { pageFirst: false }));
  for (const entry of entries) {
    if (!usable(entry)) continue;
    if (entry.id.startsWith("std:") && !(entry.flags & Row.NativeAction)) continue;
    const command = entry.flags & Row.NativeAction ? entry.id : entry.command;
    const arg = entry.flags & Row.NativeAction ? null : entry.arg;
    for (const combo of entry.active) for (const press of pressesFor(combo)) put(entryOf(press, command, arg));
  }
  if (modes.undoReopensClosedTab && modes.reopenClosedTabEnabled && !modes.textInputFocused) {
    put(entryOf({ code: "KeyZ", modifiers: Modifier.Control }, "reopenClosedTab", null, { pageFirst: true, uiOnly: true }));
  }
  for (const modifiers of [Modifier.Control, Modifier.Control | Modifier.Shift]) put(entryOf({ code: "KeyQ", modifiers }, QUIT, null, { pageFirst: false }));
  return [...map.values()];
}
