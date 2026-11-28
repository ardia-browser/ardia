import type { BrowserCommand } from "./browserCommand";

export type CommandEvent = {
  command: BrowserCommand;
  arg: string | null;
  windowId: string | null;
  focusGeneration?: number | null;
  mouseButton?: MouseShortcutButton | null;
  mouseGesture?: MouseGestureAction | null;
  gestureTabId?: string | null;
  epoch?: string;
};

export type MouseShortcutButton = "middle" | "button4" | "button5";

export type MouseGestureAction = "back" | "forward" | "reload" | "close_tab" | "reopen_closed_tab" | "new_tab" | "previous_tab" | "next_tab";
