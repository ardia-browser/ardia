const KEY_NAMES: [string, string][] = [["⌘", "Ctrl"], ["⌃", "Super"], ["⌥", "Alt"], ["⇧", "Shift"]];
const MODIFIER_RUN = /[⌘⌥⇧⌃]+(?=-[a-z])/g;
const MODIFIER = /[⌘⌥⇧⌃]/;
const MODIFIERS = /[⌘⌥⇧⌃]{2,}/g;
const linuxOrder = (run: string) => KEY_NAMES.filter(([symbol]) => run.includes(symbol)).map(([symbol]) => symbol).join("");

export const hasMacModifiers = (code: string) => MODIFIER.test(code);

export function linuxShortcutText(code: string): string {
  const pointerModifiers = code.replace(MODIFIERS, (run) => (new Set(run).size === run.length ? linuxOrder(run) : run)).replace(MODIFIER_RUN, (run) => KEY_NAMES.filter(([symbol]) => run.includes(symbol)).map(([, name]) => name).join("+"));
  return KEY_NAMES.reduce((text, [symbol, name]) => text.replaceAll(symbol, `${name}+`), pointerModifiers);
}
