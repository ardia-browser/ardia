export {
  formatWindowsShortcut as formatShortcut,
  parseWindowsShortcut as parseShortcut,
  WINDOWS_ALTERNATE_MODIFIER as ALTERNATE_MODIFIER,
  windowsDefaultKeys as defaultKeys,
  windowsModifiers as storedModifiers,
  windowsProfileSwitchKey as profileSwitchKey,
} from "./windowsKeys";

export const COMMAND_KEY: "metaKey" | "ctrlKey" = "ctrlKey";

export const commandHeld = (e: { metaKey?: boolean; ctrlKey?: boolean }): boolean => !!e.ctrlKey;
