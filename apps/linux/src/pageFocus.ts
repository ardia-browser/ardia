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
