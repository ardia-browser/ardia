import { dismissesPopover } from "./popoverEscape";

const SWALLOWED = ["mousedown", "pointerup", "pointercancel", "mouseup", "click", "auxclick", "contextmenu", "touchstart", "touchend"] as const;
const ENDS_PRESS = new Set(["pointerup", "pointercancel"]);
const LAST_OF_PRESS = new Set(["click", "auxclick"]);
const SWALLOW_MS = 800;
const CAPTURE = { capture: true } as const;
const TEXT_ENTRY = "input, textarea, [contenteditable=''], [contenteditable='true']";

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type DownloadsDismissal = {
  target: Target;
  inside: (node: EventTarget | null) => boolean;
  onInsidePress: () => void;
  close: () => void;
  menuShown: () => boolean;
  watchPageFocus: (listener: () => void) => () => void;
  activeElement: () => Pick<Element, "matches"> | null;
  now?: () => number;
};

const stopEvent = (event: Event) => {
  event.stopImmediatePropagation();
  event.preventDefault();
};

function swallowRestOfPress(target: Target, pointerId: number | undefined, now: () => number) {
  let until = Infinity;
  const release = () => {
    target.removeEventListener("pointerdown", release, CAPTURE);
    for (const type of SWALLOWED) target.removeEventListener(type, swallow, CAPTURE);
  };
  const swallow = (event: Event) => {
    if (now() > until) return release();
    stopEvent(event);
    if (ENDS_PRESS.has(event.type) && (event as PointerEvent).pointerId === pointerId) until = now() + SWALLOW_MS;
    if (LAST_OF_PRESS.has(event.type) && until !== Infinity) release();
  };
  target.addEventListener("pointerdown", release, CAPTURE);
  for (const type of SWALLOWED) target.addEventListener(type, swallow, CAPTURE);
}

export function startDownloadsDismissal({ target, inside, onInsidePress, close, menuShown, watchPageFocus, activeElement, now = () => performance.now() }: DownloadsDismissal) {
  const down = (event: Event) => {
    if (inside(event.target)) return onInsidePress();
    if (menuShown()) return;
    stopEvent(event);
    swallowRestOfPress(target, (event as PointerEvent).pointerId, now);
    close();
  };
  const key = (event: Event) => {
    if (!dismissesPopover(event as KeyboardEvent, !!activeElement()?.matches(TEXT_ENTRY), menuShown())) return;
    event.preventDefault();
    close();
  };
  target.addEventListener("pointerdown", down, CAPTURE);
  target.addEventListener("keydown", key, CAPTURE);
  const stopPage = watchPageFocus(close);
  return () => {
    target.removeEventListener("pointerdown", down, CAPTURE);
    target.removeEventListener("keydown", key, CAPTURE);
    stopPage();
  };
}
