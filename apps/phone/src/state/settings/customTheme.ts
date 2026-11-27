import { startingTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { CUSTOM_CHOICE, type ProfileLook } from "../../lib/profileLook";
import { countUsage } from "../telemetry/telemetry";
import type { PresetColor, PresetThemes } from "./preferences";
import { currentPreferences, setPreference } from "./store";
import { chosenOwnTheme, useThemeDraft } from "./themeDraft";

export function startingCustomTheme(look: ProfileLook): ProfileTheme {
  return chosenOwnTheme(currentPreferences()) ?? look.custom?.theme ?? startingTheme(look.swatch);
}

export function chooseCustomTheme(look: ProfileLook) {
  const { colorChoice, customTheme } = currentPreferences();
  if (colorChoice === CUSTOM_CHOICE && customTheme) return;
  setPreference("customTheme", customTheme ?? look.custom?.theme ?? startingTheme(look.swatch));
  setPreference("colorChoice", CUSTOM_CHOICE);
  countUsage("custom_theme_chosen");
}

export function editCustomTheme(theme: ProfileTheme, settle: boolean) {
  if (!settle) {
    useThemeDraft.setState({ draft: theme });
    return;
  }
  useThemeDraft.setState({ draft: null });
  const { colorChoice, presetThemes } = currentPreferences();
  if (colorChoice !== null && colorChoice !== CUSTOM_CHOICE) {
    setPreference("presetThemes", { ...presetThemes, [colorChoice]: theme });
  } else {
    setPreference("customTheme", theme);
    setPreference("colorChoice", CUSTOM_CHOICE);
  }
  countUsage("theme_edits");
}

export function resetPresetTheme(color: PresetColor) {
  const kept: PresetThemes = { ...currentPreferences().presetThemes };
  delete kept[color];
  setPreference("presetThemes", kept);
}

export const dropThemeDraft = () => useThemeDraft.setState({ draft: null });
