import type { ShortcutModifier } from "../../platform/commands";

export const COMBO_MODIFIER_WORDS: Readonly<Record<string, ShortcutModifier>> = {
  ctrl: "control",
  ctl: "control",
  control: "control",
  cmd: "control",
  command: "control",
  opt: "option",
  option: "option",
  alt: "option",
  shift: "shift",
};

export const COMBO_PLATFORM_KEYS: Readonly<Record<string, string>> = { delete: "", del: "" };
