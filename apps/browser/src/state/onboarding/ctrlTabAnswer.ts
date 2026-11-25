import { useBrowser } from "../browser/store";
import { ctrlTabChoice, ctrlTabShortcuts, useCtrlTabChoice } from "../commands/commandShortcuts";
import type { CtrlTabChoice, CtrlTabPreset } from "../commands/ctrlTabKeys";
import type { Settings } from "../settings/settings";
import { noteSettingsPick } from "../telemetry/settingsPickerCounts";
import { draftPreset, previewLive, setOnboardingDraft, useOnboarding } from "./onboarding";
import { CTRL_TAB_LIKE, setsUpLikeBrowser } from "./presets";

type Onboarding = Pick<ReturnType<typeof useOnboarding.getState>, "draft" | "baseline" | "prefill" | "preset" | "source">;
type Browser = Pick<ReturnType<typeof useBrowser.getState>, "settings" | "profileOrder">;

const beforePreview = (o: Onboarding = useOnboarding.getState(), b: Browser = useBrowser.getState()): Browser =>
  o.baseline.shortcuts ? { ...b, settings: { ...b.settings, shortcuts: o.baseline.shortcuts } } : b;

export function presetCtrlTab(o: Onboarding = useOnboarding.getState()): CtrlTabPreset | undefined {
  const preset = draftPreset(o);
  return preset && setsUpLikeBrowser(o.source) ? CTRL_TAB_LIKE[preset] : undefined;
}

export function onboardingCtrlTab(o: Onboarding = useOnboarding.getState(), b: Browser = useBrowser.getState()): CtrlTabChoice {
  if (o.draft.shortcuts) return ctrlTabChoice({ ...b, settings: { ...b.settings, shortcuts: o.draft.shortcuts } });
  const now = ctrlTabChoice(beforePreview(o, b));
  return now === "step" ? (presetCtrlTab(o) ?? now) : now;
}

export function useOnboardingCtrlTab(): CtrlTabChoice {
  useCtrlTabChoice();
  return useOnboarding((o) => onboardingCtrlTab(o));
}

export function pickOnboardingCtrlTab(preset: CtrlTabPreset) {
  const shortcuts = ctrlTabShortcuts(preset, beforePreview());
  if (!shortcuts) return;
  setOnboardingDraft({ shortcuts });
  previewLive({ shortcuts });
}

export function ctrlTabAnswerPatch(choice: CtrlTabChoice): Partial<Settings> {
  const shortcuts = choice === "custom" ? null : ctrlTabShortcuts(choice, beforePreview());
  return shortcuts ? { shortcuts } : {};
}

export function noteCtrlTabAnswer(choice: CtrlTabChoice) {
  if (choice !== "custom") noteSettingsPick("ctrlTab", choice);
}
