export type DownloadTurns = <T>(job: () => Promise<T>) => Promise<T>;

let last: Promise<unknown> = Promise.resolve();

let turns: DownloadTurns = (job) => {
  const turn = last.then(job);
  last = turn.catch(() => {});
  return turn;
};

export const setDownloadTurns = (next: DownloadTurns) => void (turns = next);

export const inDownloadTurn: DownloadTurns = (job) => turns(job);
