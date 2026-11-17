export type FrameDriver = {
  requestFrame(generation: number): boolean;
  cancelFrame(generation: number): void;
  listen(frame: (generation: number, failed?: boolean) => void): () => void;
};

type Frame = (time: number) => void;
type Timer = ReturnType<typeof setTimeout>;

export function createFrameQueue(now: () => number, report: (error: unknown) => void) {
  let waiting = new Map<number, Frame>();
  let turn = new Map<number, Frame>();
  let nextId = 0;
  let generation = 0;
  let pending: number | null = null;
  let driver: FrameDriver | null = null;
  let unlisten: (() => void) | undefined;
  let timer: Timer | undefined;
  let dispatching = false;
  let due = 0;
  const period = 1000 / 60;

  const schedule = () => {
    if (!waiting.size || pending !== null || dispatching) return;
    const token = ++generation;
    pending = token;
    if (driver) {
      try { if (driver.requestFrame(token)) return; } catch (error) { report(error); }
      driver = null;
    }
    timer = setTimeout(() => deliver(token), Math.max(0, due - now()));
  };

  const deliver = (token: number, failed = false) => {
    if (pending !== token) return;
    pending = null;
    timer = undefined;
    if (failed) { driver = null; schedule(); return; }
    const time = now();
    due = Math.max(due + period, time + period / 2);
    turn = waiting;
    waiting = new Map();
    dispatching = true;
    try {
      for (const [id, frame] of turn) {
        turn.delete(id);
        try { frame(time); } catch (error) { report(error); }
      }
    } finally {
      dispatching = false;
      schedule();
    }
  };

  const cancelPending = () => {
    if (pending === null) return;
    const token = pending;
    pending = null;
    clearTimeout(timer);
    timer = undefined;
    driver?.cancelFrame(token);
  };

  return {
    usesNativeClock: () => driver !== null,
    request(frame: Frame) {
      const id = ++nextId;
      waiting.set(id, frame);
      schedule();
      return id;
    },
    cancel(id: number) {
      waiting.delete(id);
      turn.delete(id);
      if (!waiting.size) cancelPending();
    },
    useDriver(next: FrameDriver | null) {
      cancelPending();
      unlisten?.();
      driver = next;
      unlisten = next?.listen(deliver);
      schedule();
    },
  };
}
