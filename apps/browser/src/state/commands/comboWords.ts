import type { ShortcutModifier } from "../../platform/commands";

export const COMBO_MODIFIER_WORDS: Readonly<Record<string, ShortcutModifier>> = {
  cmd: "command",
  command: "command",
  meta: "command",
  super: "command",
  win: "command",
  ctrl: "control",
  ctl: "control",
  control: "control",
  opt: "option",
  option: "option",
  alt: "option",
  shift: "shift",
  fn: "function",
  function: "function",
};

export const COMBO_PLATFORM_KEYS: Readonly<Record<string, string>> = { delete: "\u0008", del: "\u0008" };
