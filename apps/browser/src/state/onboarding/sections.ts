import { useMemo } from "react";
import { useBrowser } from "../browser/store";
import { usePlugins } from "../plugins/store";
import { activeSteps, goToStep, previousStep, questionsFor, useOnboarding, type OnboardingStep, type QuestionId } from "./onboarding";

export type OnboardingSection = { step: Exclude<OnboardingStep, "intro">; sub: number; id: QuestionId };

export type SectionMove = "wheel" | "key" | "click";

export function onboardingSections(): OnboardingSection[] {
  return activeSteps().flatMap((step) => (step === "intro" ? [] : questionsFor(step).map((q, sub) => ({ step, sub, id: q.id }))));
}

export const sectionIndexOf = (sections: readonly OnboardingSection[], step: OnboardingStep, sub: number) => {
  const exact = sections.findIndex((s) => s.step === step && s.sub === sub);
  if (exact >= 0) return exact;
  const inStep = sections.findIndex((s) => s.step === step);
  return inStep >= 0 ? inStep : 0;
};

export const currentSectionIndex = (sections: readonly OnboardingSection[]) => {
  const { step, sub } = useOnboarding.getState();
  return sectionIndexOf(sections, step, sub);
};

const sectionsKey = () =>
  useOnboarding.getState().windowId ? onboardingSections().map((s) => `${s.step}:${s.sub}:${s.id}`).join(",") : "";

const fromKey = (key: string): OnboardingSection[] =>
  key
    ? key.split(",").map((part) => {
        const [step, sub, id] = part.split(":");
        return { step: step as OnboardingSection["step"], sub: Number(sub), id: id as QuestionId };
      })
    : [];

export function useSections(): OnboardingSection[] {
  useOnboarding(sectionsKey);
  useBrowser(sectionsKey);
  usePlugins(sectionsKey);
  const key = sectionsKey();
  return useMemo(() => fromKey(key), [key]);
}

export function goToSection(section: OnboardingSection) {
  goToStep(section.step, section.sub);
}

export function backOneSection() {
  previousStep();
}

export const currentPlace = () => {
  const { step, sub, leaving } = useOnboarding.getState();
  return `${step}:${sub}:${leaving}`;
};
