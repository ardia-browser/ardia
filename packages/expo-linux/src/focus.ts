import type { FocusNative } from "@ardia/shell";
import { setDragEscapeCapture, setSwitcherCapture } from "./chromium/keys/keyboard";
import { appWindowDocument } from "./windows/appWindows";

type Focusable = HTMLElement & { focus(options?: FocusOptions): void };

const saved = new Map<number, Focusable>();
let nextToken = 0;

const asElement = (tag: unknown): Focusable | null => (tag && typeof (tag as Focusable).focus === "function" ? (tag as Focusable) : null);

export const linuxFocus: FocusNative = {
  setSwitcherCapture: async (active) => setSwitcherCapture(active),
  setDragEscapeCapture: async (active) => setDragEscapeCapture(active),
  cancelFocusMove: async () => {},
  async claimFocus(_generation, tag) {
    asElement(tag)?.focus({ preventScroll: true });
  },
  async saveKeyResponder(windowId) {
    const active = appWindowDocument(windowId)?.activeElement as Focusable | null;
    if (!active || active.nodeName === "BODY") return 0;
    saved.set(++nextToken, active);
    return nextToken;
  },
  async restoreKeyResponder(token) {
    const element = saved.get(token);
    saved.delete(token);
    if (!element?.isConnected) return false;
    element.focus({ preventScroll: true });
    return element.ownerDocument.activeElement === element;
  },
  async discardKeyResponder(token) {
    saved.delete(token);
  },
  switcherPointerMoved: () => false,
  pressesWithoutRelease: () => 0,
  pressRepeated: async () => null,
};
