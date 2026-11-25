import { startingTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { CUSTOM_CHOICE, type ProfileLook } from "../../lib/profileLook";
import { countUsage } from "../telemetry/telemetry";
import { pushSettings } from "./nav";
import { currentPreferences, setPreference } from "./store";
import { useThemeDraft } from "./themeDraft";

export function startingCustomTheme(look: ProfileLook): ProfileTheme {
  return currentPreferences().customTheme ?? look.custom?.theme ?? startingTheme(look.swatch);
}

export function chooseCustomTheme(look: ProfileLook) {
  const wasCustom = currentPreferences().colorChoice === CUSTOM_CHOICE;
  setPreference("customTheme", startingCustomTheme(look));
  setPreference("colorChoice", CUSTOM_CHOICE);
  if (!wasCustom) countUsage("custom_theme_chosen");
}

export function openThemeEditor(look: ProfileLook) {
  chooseCustomTheme(look);
  pushSettings({ page: "theme" });
}

export function editCustomTheme(theme: ProfileTheme, settle: boolean) {
  if (!settle) {
    useThemeDraft.setState({ draft: theme });
    return;
  }
  useThemeDraft.setState({ draft: null });
  setPreference("customTheme", theme);
  setPreference("colorChoice", CUSTOM_CHOICE);
  countUsage("theme_edits");
}

export const dropThemeDraft = () => useThemeDraft.setState({ draft: null });
