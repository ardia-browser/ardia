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
