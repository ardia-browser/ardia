import { useBrowser } from "../../browser/src/state/browser/store";
import { usePages } from "../../browser/src/state/tabs/pageState";

const TEXT_ENTRY = "input, textarea, [contenteditable=''], [contenteditable='true']";

type EscapeKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing">;
const NOTHING_FOCUSED = "body, html";

type PopoverEscape = {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  windowId: string;
  menuShown: () => boolean;
  activeElement: () => Pick<Element, "matches"> | null;
  unclaimed?: () => void;
};

export function dismissesPopover(event: EscapeKey, typing: boolean, menuOpen: boolean) {
  if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  return !event.defaultPrevented && !event.isComposing && !typing && !menuOpen;
}

export function closeWindowPopovers(windowId: string) {
  const tabs = useBrowser.getState().tabs;
  const open = Object.entries(usePages.getState().popover).filter(([tabId, popover]) => popover && tabs[tabId]?.windowId === windowId);
  if (!open.length) return false;
  usePages.setState((s) => ({ popover: { ...s.popover, ...Object.fromEntries(open.map(([tabId]) => [tabId, null])) } }));
  return true;
}

export function startPopoverEscape({ target, windowId, menuShown, activeElement, unclaimed }: PopoverEscape) {
  const listener = (event: Event) => {
    const key = event as KeyboardEvent;
    const focused = activeElement();
    if (!dismissesPopover(key, !!focused?.matches(TEXT_ENTRY), menuShown())) return;
    if (closeWindowPopovers(windowId)) return key.preventDefault();
    if (!unclaimed || key.repeat || (focused && !focused.matches(NOTHING_FOCUSED))) return;
    unclaimed();
  };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}
