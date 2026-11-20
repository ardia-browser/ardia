import { settingsReveal } from "./tokens";

export type RevealRect = { y: number; h: number };

export type RevealHost<V> = {
  find: (id: string) => V | undefined;
  whenMounted: (id: string, then: () => void) => () => void;
  measure: (view: V, done: (rect: RevealRect | null) => void) => void;
  nextFrame: (then: () => void) => () => void;
  after: (ms: number, then: () => void) => () => void;
  current: () => boolean;
};

export type RevealOutcome<V, X> = {
  extra: (view: V) => Promise<X>;
  finish: (row: RevealRect, extra: X) => void;
  onGiveUp: () => void;
  onLost: () => void;
  onWaited: () => void;
};

export function measureWithin<V>(host: Pick<RevealHost<V>, "measure" | "after">, view: V | undefined, ms: number): Promise<RevealRect | null> {
  if (!view) return Promise.resolve(null);
  return new Promise((done) => {
    let settled = false;
    const settle = (rect: RevealRect | null) => {
      if (settled) return;
      settled = true;
      stopTimer();
      done(rect);
    };
    const stopTimer = host.after(ms, () => settle(null));
    host.measure(view, settle);
  });
}

export function createRevealGuard() {
  const lost = new Set<number>();
  return {
    observe(request: number, targetHidden: boolean) {
      if (targetHidden) lost.add(request);
    },
    current(request: number, stillRequested: boolean, targetHidden: boolean) {
      if (targetHidden) lost.add(request);
      return stillRequested && !lost.has(request);
    },
  };
}

export function startReveal<V, X>(id: string, host: RevealHost<V>, outcome: RevealOutcome<V, X>): () => void {
  let live = true;
  let stop = () => {};
  const wanted = () => live && host.current();
  const stillThere = (view: V) => host.find(id) === view;
  const waitForMount = () => {
    const stopWaiting = host.whenMounted(id, () => {
      stop();
      if (!wanted()) return;
      outcome.onWaited();
      attempt(0);
    });
    const stopTimer = host.after(settingsReveal.mountDeadlineMs, () => {
      stop();
      if (wanted()) outcome.onLost();
    });
    stop = () => {
      stopWaiting();
      stopTimer();
    };
  };
  const retry = (tries: number) => (tries < settingsReveal.layoutFrames ? attempt(tries + 1) : outcome.onGiveUp());
  const attempt = (tries: number) => {
    stop = host.nextFrame(() => {
      if (!wanted()) return;
      const view = host.find(id);
      if (!view) return waitForMount();
      void measureWithin(host, view, settingsReveal.measureDeadlineMs).then((row) => {
        if (!wanted()) return;
        if (!stillThere(view) || !row?.h) return retry(tries);
        void outcome.extra(view).then((extra) => {
          if (!wanted()) return;
          if (!stillThere(view)) return retry(tries);
          outcome.finish(row, extra);
        });
      });
    });
  };
  attempt(0);
  return () => {
    live = false;
    stop();
  };
}
