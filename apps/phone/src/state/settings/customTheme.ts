import { startingTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { CUSTOM_CHOICE, type ProfileLook } from "../../lib/profileLook";
import { countUsage } from "../telemetry/telemetry";
import { PRESET_COLORS, type ColorChoice, type PresetColor, type PresetThemes } from "./preferences";
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

const isPresetColor = (key: string | null): key is PresetColor => PRESET_COLORS.includes(key as PresetColor);

export function editedChoice(colorChoice: ColorChoice | null, look: ProfileLook, matchingMac: boolean): ColorChoice {
  if (colorChoice !== null) return colorChoice;
  if (matchingMac) return CUSTOM_CHOICE;
  return !look.custom && isPresetColor(look.preset) ? look.preset : CUSTOM_CHOICE;
}

export function editCustomTheme(theme: ProfileTheme, settle: boolean, target: ColorChoice = CUSTOM_CHOICE) {
  if (!settle) {
    useThemeDraft.setState({ draft: theme });
    return;
  }
  useThemeDraft.setState({ draft: null });
  const { colorChoice, presetThemes } = currentPreferences();
  const edited = colorChoice ?? target;
  if (edited !== CUSTOM_CHOICE) {
    setPreference("presetThemes", { ...presetThemes, [edited]: theme });
  } else {
    setPreference("customTheme", theme);
  }
  setPreference("colorChoice", edited);
  countUsage("theme_edits");
}

export function resetPresetTheme(color: PresetColor) {
  const kept: PresetThemes = { ...currentPreferences().presetThemes };
  delete kept[color];
  setPreference("presetThemes", kept);
}

export const dropThemeDraft = () => useThemeDraft.setState({ draft: null });
