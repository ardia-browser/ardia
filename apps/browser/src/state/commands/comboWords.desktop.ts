import type { ShortcutModifier } from "../../platform/commands";

export const COMBO_MODIFIER_WORDS: Readonly<Record<string, ShortcutModifier>> = {
  ctrl: "command",
  ctl: "command",
  control: "command",
  cmd: "command",
  command: "command",
  super: "control",
  win: "control",
  meta: "control",
  opt: "option",
  option: "option",
  alt: "option",
  shift: "shift",
};

export const COMBO_PLATFORM_KEYS: Readonly<Record<string, string>> = { delete: "", del: "" };
