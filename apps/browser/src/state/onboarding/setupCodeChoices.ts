import { useBrowser } from "../browser/store";
import type { SetupChoices } from "../presets/setupCode";
import type { Settings } from "../settings/settings";
import { saveOnboarding } from "./onboardingDocument";
import { useOnboarding } from "./onboarding";

export function adoptSetupChoices(choices: SetupChoices, lines: string[]) {
  useOnboarding.setState((o) => {
    const draft = { ...o.draft };
    const baseline = { ...o.baseline };
    for (const key of Object.keys(choices.settings)) {
      delete draft[key as keyof Settings];
      delete baseline[key as keyof Settings];
    }
    if (choices.color) {
      delete baseline.color;
      const showing = o.windowId ? useBrowser.getState().windows[o.windowId]?.profileId : undefined;
      if (showing && baseline.looks?.[showing]) {
        const { [showing]: _taken, ...others } = baseline.looks;
        baseline.looks = others;
      }
    }
    return {
      preset: choices.preset ?? o.preset,
      source: null,
      prefill: "current" as const,
      draft,
      baseline,
      extras: choices.pins ? { ...o.extras, pins: choices.pins } : o.extras,
      picked: { ...o.picked, source: lines },
    };
  });
  const { redo, preset } = useOnboarding.getState();
  if (!redo) saveOnboarding({ source: null, preset });
}
