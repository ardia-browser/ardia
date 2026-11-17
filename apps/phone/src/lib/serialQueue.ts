export type Task = (expired: () => boolean) => Promise<void> | void;

export function serialQueue(deadlineMs = Infinity, onLate: () => void = () => undefined) {
  let tail: Promise<void> = Promise.resolve();
  const withDeadline = (work: Task): Promise<void> => {
    let late = false;
    const expired = () => late;
    if (!Number.isFinite(deadlineMs)) return Promise.resolve().then(() => work(expired));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((done) => {
      timer = setTimeout(() => {
        late = true;
        onLate();
        done();
      }, deadlineMs);
    });
    return Promise.race([Promise.resolve().then(() => work(expired)), deadline]).finally(() => clearTimeout(timer));
  };
  return (work: Task): Promise<void> => {
    const run = tail.then(() => withDeadline(work)).catch(() => undefined);
    tail = run;
    return run;
  };
}
