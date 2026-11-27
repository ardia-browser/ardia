let quitting = false;

export const isQuitting = () => quitting;
const quittingListeners = new Set<(on: boolean) => void>();

export function onQuittingChanged(listener: (on: boolean) => void) {
  quittingListeners.add(listener);
  return () => void quittingListeners.delete(listener);
}

export function setQuitting(on: boolean) {
  if (quitting === on) return;
  quitting = on;
  for (const listener of [...quittingListeners]) listener(on);
}

const quitSaves = new Set<() => Promise<void>>();
const reportFailure = (error: unknown) => console.warn("[quit] a save before quitting failed", error);

export function saveBeforeQuit(save: () => Promise<void>): () => void {
  quitSaves.add(save);
  return () => void quitSaves.delete(save);
}

export async function finishQuitSaves(deadlineMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, deadlineMs)));
  const saves = [...quitSaves].map((save) => Promise.resolve().then(save).catch(reportFailure));
  await Promise.race([Promise.all(saves), deadline]);
  clearTimeout(timer);
}

export const answerQuitAfterSaves = (deadlineMs: number, answer: () => unknown) =>
  finishQuitSaves(deadlineMs)
    .catch(reportFailure)
    .then(() => void answer());
