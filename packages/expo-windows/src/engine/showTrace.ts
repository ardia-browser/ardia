const STEPS_KEPT = 40;

let traced: ((key: string) => boolean) | null = null;
const steps = new Map<string, string[]>();

export function traceShowsOf(match: ((key: string) => boolean) | null) {
  traced = match;
  steps.clear();
}

export function noteShowStep(key: string, step: string) {
  if (!traced?.(key)) return;
  const kept = steps.get(key) ?? [];
  kept.push(`${Date.now() % 100000} ${step}`);
  steps.set(key, kept.slice(-STEPS_KEPT));
}

export const showStepsOf = (key: string) => [...(steps.get(key) ?? [])];
