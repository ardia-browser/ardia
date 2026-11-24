const MODIFIER_NAMES: readonly (readonly [string, string])[] = [["⌘", "Ctrl"], ["⌃", "Win"], ["⌥", "Alt"], ["⇧", "Shift"]];
const KEY_NAMES: Readonly<Record<string, string>> = { "↩": "Enter", "⌫": "Backspace", "⎋": "Esc" };
const LEADING_MODIFIERS = /^[⌘⌃⌥⇧]+/;

export function keyText(mac: string): string {
  const held = mac.match(LEADING_MODIFIERS)?.[0] ?? "";
  const key = mac.slice(held.length);
  const names = MODIFIER_NAMES.filter(([glyph]) => held.includes(glyph)).map(([, name]) => name);
  return [...names, ...(key ? [KEY_NAMES[key] ?? key] : [])].join("+");
}
