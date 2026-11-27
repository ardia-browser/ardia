import type { ShortcutModifier } from "@ardia-real/shell";

export const MODIFIER_FLAGS: Readonly<Record<ShortcutModifier, number>> = { command: 4, control: 16, option: 8, shift: 2, function: 0 };

export const MODIFIER_KEYS: Readonly<Record<string, ShortcutModifier>> = { Control: "command", Meta: "control", Alt: "option", Shift: "shift" };

export const COMMAND_PRESSED = (event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">) => event.ctrlKey;

export const CONTROL_PRESSED = (event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">) => event.metaKey;

export const DEFAULT_KEYS: Readonly<Record<string, readonly string[]>> = {
  focusCommandBar: ["⌘L", "F6", "⌥D"],
  reload: ["⌘R", "F5"],
  forceReload: ["⇧⌘R", "⇧F5"],
  devTools: ["⇧⌘I", "⌥⌘I"],
  emailPageLocation: [],
  jumpToSelection: [],
  downloads: ["⌘J", "⌥⌘L"],
  javaScriptConsole: ["⇧⌘J", "⌥⌘J"],
  zoomIn: ["⌘=", "⇧⌘="],
  openSplitPane: ["⌘\\"],
  back: ["⌘[", "⌥←"],
  forward: ["⌘]", "⌥→"],
  nextTab: ["⇧⌘]", "⌘⇟", "⌥⌘↓"],
  previousTab: ["⇧⌘[", "⌘⇞", "⌥⌘↑"],
  openSplitPaneBelow: ["⇧⌘\\"],
  moveSplitPaneLeft: ["⌥⇧←"],
  moveSplitPaneRight: ["⌥⇧→"],
  moveSplitPaneUp: ["⌥⇧↑"],
  moveSplitPaneDown: ["⌥⇧↓"],
  "tabSwitcher:forward": ["⌘⇥"],
  "tabSwitcher:backward": ["⇧⌘⇥"],
  "std:quit:": ["⇧⌘Q"],
  "std:toggleFullScreen:": ["F11"],
};

export const SHORTCUTS_SHOWN_AS_GLYPHS = false;

export const EDITS_TEXT = (_keyCode: number, _modifiers: number): boolean => false;
