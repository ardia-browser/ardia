const MODIFIER_RUN = /[⌘⌥⇧⌃]+(?=-[a-z])/g;
const MODIFIER = /[⌘⌥⇧⌃]/;
const MODIFIERS = /[⌘⌥⇧⌃]{2,}/g;
const MAC_KEY_TEXT = /\$\{keyText\("([⌘⌥⇧⌃][^"\\`$]*)"\)\}/g;

const keyNames = (controlKey: string): [string, string][] => [["⌘", "Ctrl"], ["⌃", controlKey], ["⌥", "Alt"], ["⇧", "Shift"]];

export const hasMacModifiers = (code: string) => MODIFIER.test(code);

export function desktopShortcutText(controlKey: string): (code: string) => string {
  const names = keyNames(controlKey);
  const desktopOrder = (run: string) => names.filter(([symbol]) => run.includes(symbol)).map(([symbol]) => symbol).join("");
  return (code) => {
    const pointerModifiers = code.replace(MAC_KEY_TEXT, "$1").replace(MODIFIERS, (run) => (new Set(run).size === run.length ? desktopOrder(run) : run)).replace(MODIFIER_RUN, (run) => names.filter(([symbol]) => run.includes(symbol)).map(([, name]) => name).join("+"));
    return names.reduce((text, [symbol, name]) => text.replaceAll(symbol, `${name}+`), pointerModifiers);
  };
}

export const linuxShortcutText = desktopShortcutText("Super");
