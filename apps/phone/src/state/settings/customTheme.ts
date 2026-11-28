import { startingTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { CUSTOM_CHOICE, type ProfileLook } from "../../lib/profileLook";
import { countUsage } from "../telemetry/telemetry";
import { matchMyMac } from "../sync/actions";
import type { ColorChoice, PresetColor, PresetThemes } from "./preferences";
import { currentPreferences, setPreference } from "./store";
import { chosenOwnTheme, isPresetColor, themeLockedNow, useThemeDraft } from "./themeDraft";

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

export function editedChoice(colorChoice: ColorChoice | null, look: ProfileLook): ColorChoice {
  if (colorChoice !== null) return colorChoice;
  return !look.custom && isPresetColor(look.preset) ? look.preset : CUSTOM_CHOICE;
}

export function editCustomTheme(theme: ProfileTheme, settle: boolean, target: ColorChoice = CUSTOM_CHOICE) {
  if (themeLockedNow()) {
    useThemeDraft.setState({ draft: null });
    return;
  }
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
  if (themeLockedNow()) return;
  const kept: PresetThemes = { ...currentPreferences().presetThemes };
  delete kept[color];
  setPreference("presetThemes", kept);
}

export const dropThemeDraft = () => useThemeDraft.setState({ draft: null });

export function stopMatchingToEdit(look: ProfileLook) {
  if (look.custom && currentPreferences().customTheme) {
    setPreference("colorChoice", CUSTOM_CHOICE);
    return;
  }
  matchMyMac(false, look);
}
