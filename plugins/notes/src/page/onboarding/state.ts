import { useEffect, useState } from "react";
import type { ImportSourceId } from "../../shared/importSources";
import { countStat } from "./stats";

export const ONBOARDING_KEY = "notes:onboarding";

export const STEPS = ["welcome", "import", "template", "together", "agents", "tour"] as const;
export type OnboardingStep = (typeof STEPS)[number];

export const STEP_LABELS: Record<OnboardingStep, string> = { welcome: "Welcome", import: "Your notes", template: "Template", together: "Together", agents: "Agents", tour: "Tour" };

export type OnboardingState = {
  v: 1;
  status: "active" | "done";
  step: OnboardingStep;
  workspace: string;
  name: string;
  color: string;
  importSource: ImportSourceId | "fresh" | null;
  importJob: string | null;
  importRoot: string | null;
  template: string;
  gettingStarted: string | null;
  built: Record<string, string>;
  shared: { kind: "created" | "joined"; workspace: string; name: string } | null;
  tourIndex: number;
  tourPage: string | null;
  agentDemoJob: string | null;
  agentDemoPage: string | null;
  counted: string[];
};

export const freshState = (workspace: string, name: string, color: string, counted: string[] = []): OnboardingState => ({
  v: 1,
  status: "active",
  step: "welcome",
  workspace,
  name,
  color,
  importSource: null,
  importJob: null,
  importRoot: null,
  template: "blank",
  gettingStarted: null,
  built: {},
  shared: null,
  tourIndex: 0,
  tourPage: null,
  agentDemoJob: null,
  agentDemoPage: null,
  counted,
});

function read(): OnboardingState | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (!parsed || parsed.v !== 1 || !STEPS.includes(parsed.step as OnboardingStep)) return null;
    return { ...freshState(String(parsed.workspace ?? ""), String(parsed.name ?? ""), String(parsed.color ?? "")), ...parsed } as OnboardingState;
  } catch {
    return null;
  }
}

let current: OnboardingState | null = read();
const listeners = new Set<(value: OnboardingState | null) => void>();

function write(next: OnboardingState | null) {
  current = next;
  try {
    if (next) localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next));
    else localStorage.removeItem(ONBOARDING_KEY);
  } catch {}
  listeners.forEach((l) => l(current));
}

export function onboardingState() {
  return current;
}

export function updateOnboarding(patch: Partial<OnboardingState> | ((old: OnboardingState) => Partial<OnboardingState>)) {
  if (!current) return;
  const resolved = typeof patch === "function" ? patch(current) : patch;
  write({ ...current, ...resolved });
}

export function countOnce(key: string) {
  if (!current) return countStat(key);
  if (current.counted.includes(key)) return;
  countStat(key);
  write({ ...current, counted: [...current.counted, key].slice(-200) });
}

export function startOnboarding(workspace: string, name: string, color: string, replay = false) {
  countStat(replay ? "onboarding.replayed" : "onboarding.shown");
  write(freshState(workspace, name, color));
  countOnce("onboarding.step.welcome.reached");
}

export function goToStep(step: OnboardingStep) {
  updateOnboarding({ step });
  countOnce(`onboarding.step.${step}.reached`);
}

export function skipStep(step: OnboardingStep) {
  countStat(`onboarding.step.${step}.skipped`);
}

export function finishOnboarding(how: "done" | "skipped") {
  countStat(how === "done" ? "onboarding.done" : "onboarding.skipped");
  updateOnboarding({ status: "done" });
}

let replayRequest: (() => void) | null = null;

export function setReplayHandler(handler: (() => void) | null) {
  replayRequest = handler;
}

export function replayOnboarding() {
  replayRequest?.();
}

export function useOnboardingState(): OnboardingState | null {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

export function markOnboardingSeen(workspace: string) {
  if (current) return;
  write({ ...freshState(workspace, "", ""), status: "done" });
}
