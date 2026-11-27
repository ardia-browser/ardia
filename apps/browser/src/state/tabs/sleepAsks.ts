import { withDeadline } from "../../lib/deadline";

const ANSWER_WITHIN_MS = 1500;

const inFlightSleeps = new Set<string>();
const shownGeneration = new Map<string, number>();
const readyGeneration = new Map<string, number>();
const bump = (generations: Map<string, number>, id: string) => generations.set(id, (generations.get(id) ?? 0) + 1);

export type SleepAnswer = { keptBy: number[] | undefined; openedMeanwhile: boolean; awakeMeanwhile: boolean };

export const sleepAskedNow = (tabId: string) => inFlightSleeps.has(tabId);

export const noteShownAgain = (tabId: string) => void bump(shownGeneration, tabId);

export const noteTabReady = (tabId: string) => void bump(readyGeneration, tabId);

export function forgetSleepAsks(tabId: string) {
  shownGeneration.delete(tabId);
  readyGeneration.delete(tabId);
}

export async function askToSleep(id: string, ask: () => Promise<number[]> | undefined, settle: (answer: SleepAnswer) => void): Promise<void> {
  inFlightSleeps.add(id);
  const shownAt = shownGeneration.get(id) ?? 0;
  const readyAt = readyGeneration.get(id) ?? 0;
  try {
    const keptBy = await withDeadline(Promise.resolve().then(ask).catch(() => undefined), ANSWER_WITHIN_MS, undefined);
    const openedMeanwhile = (shownGeneration.get(id) ?? 0) !== shownAt;
    settle({ keptBy, openedMeanwhile, awakeMeanwhile: openedMeanwhile || (readyGeneration.get(id) ?? 0) !== readyAt });
  } finally {
    inFlightSleeps.delete(id);
  }
}

type SleepAsker = { sleepIfHidden(seconds: number): Promise<number[]>; sleepIfUnused?(seconds: number): Promise<number[]> };

export function askUnusedSleep(view: SleepAsker, seconds: number): Promise<number[]> {
  if (!view.sleepIfUnused) return view.sleepIfHidden(seconds);
  return Promise.resolve()
    .then(() => view.sleepIfUnused!(seconds))
    .catch(() => view.sleepIfHidden(seconds));
}
