let quitting = false;

export const isQuitting = () => quitting;
export const setQuitting = (on: boolean) => void (quitting = on);

const quitSaves = new Map<string, () => Promise<void>>();
const reportFailure = (error: unknown) => console.warn("[quit] a save before quitting failed", error);

export const saveBeforeQuit = (name: string, save: () => Promise<void>) => void quitSaves.set(name, save);

export type QuitSaves = { ms: number; finished: Record<string, number>; unfinished: string[] };

export async function finishQuitSaves(deadlineMs: number): Promise<QuitSaves> {
  const started = Date.now();
  const finished: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, deadlineMs)));
  const saves = [...quitSaves].map(([name, save]) =>
    Promise.resolve()
      .then(save)
      .catch(reportFailure)
      .then(() => void (finished[name] = Date.now() - started)),
  );
  await Promise.race([Promise.all(saves), deadline]);
  clearTimeout(timer);
  return { ms: Date.now() - started, finished: { ...finished }, unfinished: [...quitSaves.keys()].filter((name) => !(name in finished)) };
}

export function quitSavesLine(flushMs: number, saves: QuitSaves) {
  const each = Object.entries(saves.finished).map(([name, ms]) => `, ${name} in ${ms} ms`);
  const gaveUp = saves.unfinished.length ? `; gave up on ${saves.unfinished.join(", ")} after ${saves.ms} ms` : "";
  return `[quit] last saves: session flushed in ${flushMs} ms${each.join("")}${gaveUp}`;
}

export const answerQuitAfterSaves = (deadlineMs: number, answer: () => unknown, flushMs = 0) =>
  finishQuitSaves(deadlineMs)
    .then((saves) => console.info(quitSavesLine(flushMs, saves)))
    .catch(reportFailure)
    .then(() => void answer());
