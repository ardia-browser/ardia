type PluginShortcutModifier = "control" | "option" | "shift" | "command";

export type PluginShortcut = { key: string; control: boolean; option: boolean; shift: boolean };

export type ShortcutKeyEvent = { key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type ShortcutHandledKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

type CommandFlag = "metaKey" | "ctrlKey";

const MODIFIER_WORDS: Record<string, PluginShortcutModifier> = {
  cmd: "command",
  command: "command",
  ctrl: "control",
  control: "control",
  opt: "option",
  option: "option",
  alt: "option",
  shift: "shift",
};
const MODIFIER_GLYPHS: Record<string, PluginShortcutModifier> = { "⌘": "command", "⌃": "control", "⌥": "option", "⇧": "shift" };
const PUNCTUATION = "-=[]\\;',./`";
const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;
const LIFECYCLE_KEYS = new Set(["q", "w", "t", "n", "h", "m"]);
const RESERVED = new Set([
  "cmd+a",
  "cmd+c",
  "cmd+v",
  "cmd+x",
  "cmd+z",
  "cmd+shift+z",
  "cmd+shift+v",
  "cmd+opt+shift+v",
  "cmd+,",
  "cmd+`",
  "cmd+shift+`",
  "cmd+space",
  "cmd+ctrl+space",
  "cmd+opt+space",
  "cmd+ctrl+f",
  "cmd+ctrl+q",
]);
const MAX_TEXT = 40;

function keyOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "space") return "space";
  if (FUNCTION_KEY.test(lower)) return lower;
  if (Array.from(lower).length !== 1) return null;
  return /^[a-z0-9]$/.test(lower) || PUNCTUATION.includes(lower) ? lower : null;
}

function partsOf(text: string): { modifiers: PluginShortcutModifier[]; name: string } | null {
  if (text.includes("+")) {
    const words = text.split("+").map((w) => w.trim());
    const name = words.pop() ?? "";
    if (!name && text.endsWith("+")) return null;
    const modifiers = words.map((w) => MODIFIER_WORDS[w.toLowerCase()]);
    return modifiers.every((m): m is PluginShortcutModifier => m !== undefined) ? { modifiers, name } : null;
  }
  const chars = Array.from(text);
  let at = 0;
  const modifiers: PluginShortcutModifier[] = [];
  while (at < chars.length - 1 && Object.hasOwn(MODIFIER_GLYPHS, chars[at]!)) modifiers.push(MODIFIER_GLYPHS[chars[at++]!]!);
  return { modifiers, name: chars.slice(at).join("") };
}

export function parsePluginShortcut(raw: unknown): (PluginShortcut & { command: boolean }) | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MAX_TEXT) return null;
  const parts = partsOf(text);
  if (!parts) return null;
  if (new Set(parts.modifiers).size !== parts.modifiers.length) return null;
  const key = keyOf(parts.name);
  if (!key) return null;
  const has = (m: PluginShortcutModifier) => parts.modifiers.includes(m);
  return { key, command: has("command"), control: has("control"), option: has("option"), shift: has("shift") };
}

export function pluginShortcutText(s: PluginShortcut): string {
  return ["cmd", s.control && "ctrl", s.option && "opt", s.shift && "shift", s.key].filter(Boolean).join("+");
}

function isRefusedShortcut(s: PluginShortcut & { command: boolean }): boolean {
  if (!s.command) return true;
  if (s.shift && s.key.length === 1 && !/^[a-z]$/.test(s.key)) return true;
  return LIFECYCLE_KEYS.has(s.key) || RESERVED.has(pluginShortcutText(s));
}

export function pluginShortcutOf(raw: unknown): PluginShortcut | null {
  const parsed = parsePluginShortcut(raw);
  if (!parsed || isRefusedShortcut(parsed)) return null;
  return { key: parsed.key, control: parsed.control, option: parsed.option, shift: parsed.shift };
}

export function pluginShortcutModifiers(s: PluginShortcut): PluginShortcutModifier[] {
  return [...(s.control ? ["control" as const] : []), ...(s.option ? ["option" as const] : []), ...(s.shift ? ["shift" as const] : []), "command"];
}

const FIRST_FUNCTION_KEY_CODE = 0xf704;

export function pluginShortcutKeyChar(s: PluginShortcut): string {
  if (s.key === "space") return " ";
  const fn = FUNCTION_KEY.exec(s.key);
  return fn ? String.fromCharCode(FIRST_FUNCTION_KEY_CODE + Number(fn[1]) - 1) : s.key;
}

function eventKeysOf(s: PluginShortcut): string[] {
  if (s.key === "space") return [" "];
  if (FUNCTION_KEY.test(s.key)) return [s.key.toUpperCase()];
  return /^[a-z]$/.test(s.key) ? [s.key, s.key.toUpperCase()] : [s.key];
}

function flagsOf(s: PluginShortcut, commandFlag: CommandFlag) {
  const ctrlKey = s.control || commandFlag === "ctrlKey";
  return { metaKey: commandFlag === "metaKey", ctrlKey, altKey: s.option, shiftKey: s.shift };
}

export function pluginShortcutHandledKeys(s: PluginShortcut, commandFlag: CommandFlag): ShortcutHandledKey[] {
  const flags = flagsOf(s, commandFlag);
  return eventKeysOf(s).map((key) => ({ key, ...flags }));
}

export function pluginShortcutMatches(s: PluginShortcut, e: ShortcutKeyEvent, commandFlag: CommandFlag): boolean {
  if (typeof e.key !== "string" || !e.key) return false;
  const flags = flagsOf(s, commandFlag);
  if (!!e.metaKey !== flags.metaKey || !!e.ctrlKey !== flags.ctrlKey || !!e.altKey !== flags.altKey || !!e.shiftKey !== flags.shiftKey) return false;
  const pressed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return eventKeysOf(s).some((k) => (k.length === 1 ? k.toLowerCase() : k) === pressed);
}

export type ShortcutBinding<A> = { shortcut: PluginShortcut; action: A };

export type ShortcutRegistration<A> = { depth: number; seq: number; bindings: readonly ShortcutBinding<A>[] };

export function bindingsOf<A extends { props: Record<string, unknown> }>(actions: readonly A[]): ShortcutBinding<A>[] {
  return actions.flatMap((action) => {
    const shortcut = pluginShortcutOf(action.props.shortcut);
    return shortcut ? [{ shortcut, action }] : [];
  });
}

export function mergeShortcutBindings<A>(registrations: Iterable<ShortcutRegistration<A>>, heldElsewhere: (s: PluginShortcut) => boolean = () => false): ShortcutBinding<A>[] {
  const ordered = [...registrations].sort((a, b) => a.depth - b.depth || a.seq - b.seq);
  const seen = new Set<string>();
  const out: ShortcutBinding<A>[] = [];
  for (const registration of ordered) {
    for (const binding of registration.bindings) {
      const combo = pluginShortcutText(binding.shortcut);
      if (seen.has(combo)) continue;
      seen.add(combo);
      if (!heldElsewhere(binding.shortcut)) out.push(binding);
    }
  }
  return out;
}

export function pressedBinding<A>(bindings: readonly ShortcutBinding<A>[], e: ShortcutKeyEvent, commandFlag: CommandFlag): ShortcutBinding<A> | null {
  return bindings.find((b) => pluginShortcutMatches(b.shortcut, e, commandFlag)) ?? null;
}

export function handledKeysOf<A>(bindings: readonly ShortcutBinding<A>[], commandFlag: CommandFlag): ShortcutHandledKey[] {
  return bindings.flatMap((b) => pluginShortcutHandledKeys(b.shortcut, commandFlag));
}
