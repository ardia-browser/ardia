import type { StateCreator } from "zustand";

export function transactional<T>(heardAlone?: (s: T, prev: T) => boolean, settle?: (s: T, prev: T) => T) {
  let depth = 0;
  let together = 0;
  let heard: T | null = null;
  let hear = () => {};
  const afterEach = new Set<() => void>();

  const middleware =
    (creator: StateCreator<T>): StateCreator<T> =>
    (set, get, api) => {
      type Listener = (s: T, prev: T) => void;
      const listeners = new Set<Listener>();
      let settling = false;
      let settledAt: T | null = null;
      const settleNow = (prev: T) => {
        const current = api.getState();
        const settled = settle ? settle(current, prev) : current;
        if (settled !== current) {
          settling = true;
          try {
            (set as (state: T, replace: true) => void)(settled, true);
          } finally {
            settling = false;
          }
        }
        return api.getState();
      };
      const publish = (prev: T) => {
        if (api.getState() !== settledAt) settleNow(prev);
        settledAt = null;
        listeners.forEach((listener) => listener(api.getState(), prev));
      };
      hear = () => {
        const prev = heard;
        if (prev === null) return;
        heard = null;
        if (api.getState() === prev) {
          settledAt = null;
          return;
        }
        const held = depth;
        depth = 0;
        try {
          publish(prev);
        } finally {
          depth = held;
        }
      };
      api.subscribe((s, prev) => {
        if (settling) return;
        if (!depth) return publish(prev);
        heard ??= prev;
        if (together) settledAt = settleNow(settledAt ?? heard);
        else {
          settledAt = null;
          if (heardAlone?.(s, prev)) hear();
        }
      });
      api.subscribe = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      return creator(set, get, api);
    };

  const transaction = (run: () => void, o: { together?: boolean } = {}) => {
    const joint = Boolean(o.together);
    depth++;
    if (joint) together++;
    try {
      run();
    } finally {
      if (joint) together--;
      if (--depth === 0) {
        try {
          hear();
        } finally {
          afterEach.forEach((listener) => listener());
        }
      }
    }
  };
  const afterTransactionIdempotent = (listener: () => void) => {
    afterEach.add(listener);
    return () => void afterEach.delete(listener);
  };
  const inTransaction = () => depth > 0;
  return { middleware, transaction, afterTransactionIdempotent, inTransaction };
}
