import { withDeadline } from "../../lib/deadline";

const ANSWER_WITHIN_MS = 1500;

let lastStamp = 0;
const inFlightSleeps = new Map<string, number>();
const shownGeneration = new Map<string, number>();
const readyGeneration = new Map<string, number>();
const bump = (generations: Map<string, number>, id: string) => generations.set(id, ++lastStamp);

export type SleepAnswer = { keptBy: number[] | undefined; openedMeanwhile: boolean; awakeMeanwhile: boolean };

export const sleepAskedNow = (tabId: string) => inFlightSleeps.has(tabId);

export const noteShownAgain = (tabId: string) => void bump(shownGeneration, tabId);

export const noteTabReady = (tabId: string) => void bump(readyGeneration, tabId);

export function forgetSleepAsks(tabId: string) {
  shownGeneration.delete(tabId);
  readyGeneration.delete(tabId);
  inFlightSleeps.delete(tabId);
}

export async function askToSleep(id: string, ask: () => Promise<number[]> | undefined, settle: (answer: SleepAnswer) => void): Promise<void> {
  const ticket = ++lastStamp;
  inFlightSleeps.set(id, ticket);
  const shownAt = shownGeneration.get(id) ?? 0;
  const readyAt = readyGeneration.get(id) ?? 0;
  try {
    const keptBy = await withDeadline(Promise.resolve().then(ask).catch(() => undefined), ANSWER_WITHIN_MS, undefined);
    if (inFlightSleeps.get(id) !== ticket) return;
    const openedMeanwhile = (shownGeneration.get(id) ?? 0) !== shownAt;
    settle({ keptBy, openedMeanwhile, awakeMeanwhile: openedMeanwhile || (readyGeneration.get(id) ?? 0) !== readyAt });
  } finally {
    if (inFlightSleeps.get(id) === ticket) inFlightSleeps.delete(id);
  }
}

type SleepAsker = { sleepIfHidden(seconds: number): Promise<number[]>; sleepIfUnused?(seconds: number): Promise<number[]> };

export function askUnusedSleep(view: SleepAsker, seconds: number): Promise<number[]> {
  if (!view.sleepIfUnused) return view.sleepIfHidden(seconds);
  return Promise.resolve()
    .then(() => view.sleepIfUnused!(seconds))
    .catch(() => view.sleepIfHidden(seconds));
}
