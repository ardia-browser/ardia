import type { FocusTarget } from "../ui/coverFocus";

let opener: FocusTarget | null = null;

export function openPageMenuFrom(target: FocusTarget, open: () => void) {
  opener = target;
  open();
}

export const pageMenuOpener: FocusTarget = () => opener?.() ?? null;
