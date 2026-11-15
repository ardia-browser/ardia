import type { FocusNative } from "@ardia/shell";
import { setDragEscapeCapture, setSwitcherCapture } from "./chromium/keys/keyboard";
import { linuxFocus as shared } from "./focus.ts";

export const linuxFocus: FocusNative = {
  ...shared,
  setSwitcherCapture: async (active) => setSwitcherCapture(active),
  setDragEscapeCapture: async (active) => setDragEscapeCapture(active),
};
