type Waiting<T> = { arg: T; done: Promise<void>; settle: (pass: Promise<void>) => void };

export function passAfterEachRequest<T>(run: (arg: T) => Promise<void>): (arg: T) => Promise<void> {
  let running = false;
  let next: Waiting<T> | null = null;
  const start = (arg: T): Promise<void> => {
    running = true;
    const pass = run(arg);
    const after = () => {
      const waiting = next;
      next = null;
      running = !!waiting;
      if (waiting) waiting.settle(start(waiting.arg));
    };
    pass.then(after, after);
    return pass;
  };
  return (arg) => {
    if (!running) return start(arg);
    if (next) {
      next.arg = arg;
      return next.done;
    }
    let settle!: Waiting<T>["settle"];
    const done = new Promise<void>((resolve, reject) => (settle = (pass) => pass.then(resolve, reject)));
    next = { arg, done, settle };
    return done;
  };
}
