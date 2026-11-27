import { reportHostError } from "./host.ts";

const listeners = new Set<() => void>();

export function watchPageFocus(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const requests = new Set<() => void>();

export function watchPageFocusRequests(listener: () => void) {
  requests.add(listener);
  return () => void requests.delete(listener);
}

export function notePageFocusRequest() {
  for (const listener of [...requests]) listener();
}

export const notingPageFocus = <P extends { onPageFocus?: () => void }>(props: P): P => ({
  ...props,
  onPageFocus: () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        reportHostError(error);
      }
    }
    props.onPageFocus?.();
  },
});

const SHELL_TEXT_ENTRY = "input, textarea, [contenteditable=''], [contenteditable='true']";

export async function focusPageIfShellUnfocused(focusPage: () => Promise<unknown>, shellFocus: Element | null = typeof document === "undefined" ? null : document.activeElement) {
  if (shellFocus?.matches(SHELL_TEXT_ENTRY)) return false;
  notePageFocusRequest();
  return focusPage().then(() => true, () => false);
}

type YieldingPage = { command(command: string, args: unknown[]): Promise<unknown> };
const yieldingPages = new Set<YieldingPage>();

export function canYieldKeyboard(page: YieldingPage) {
  yieldingPages.add(page);
  return () => void yieldingPages.delete(page);
}

let handoffs = 0;
const shellDocumentHasKeyboard = () => typeof document === "undefined" || document.hasFocus();
const focusedElement = () => (typeof document === "undefined" ? null : document.activeElement);

export async function handKeyboardToShell(field: HTMLElement, shellHasKeyboard: () => boolean = shellDocumentHasKeyboard, active: () => Element | null = focusedElement) {
  if (shellHasKeyboard() || !field.matches(SHELL_TEXT_ENTRY)) return false;
  const handoff = ++handoffs;
  for (const page of [...yieldingPages]) {
    if (await page.command("blur", []).then(() => true, () => false)) break;
  }
  return handoff === handoffs && field.isConnected && active() === field;
}

const HANDS_KEYBOARD = Symbol("ardiaHandsKeyboard");

export function handsKeyboardOnFocus(field: HTMLElement & { [HANDS_KEYBOARD]?: true }, active: () => Element | null = focusedElement) {
  if (field[HANDS_KEYBOARD]) return;
  const focus = field.focus;
  Object.assign(field, {
    [HANDS_KEYBOARD]: true as const,
    focus(options?: FocusOptions) {
      focus.call(field, options);
      void handKeyboardToShell(field);
    },
  });
  if (active() === field) void handKeyboardToShell(field);
}
