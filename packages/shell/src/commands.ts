import type { BrowserCommand } from "./browserCommand";

export type CommandEvent = {
  command: BrowserCommand;
  arg: string | null;
  windowId: string | null;
  focusGeneration?: number | null;
  mouseButton?: MouseShortcutButton | null;
  epoch?: string;
};

export type MouseShortcutButton = "middle" | "button4" | "button5";
