import type { StateCreator } from "zustand";

type KeyedListener<T> = (s: T, prev: T) => void;
export type SubscribeTo<T> = (keys: readonly (keyof T)[], listener: KeyedListener<T>) => () => void;

export function transactional<T>(heardAlone?: (s: T, prev: T) => boolean, settle?: (s: T, prev: T) => T) {
  let depth = 0;
  let heard: T | null = null;
  let hear = () => {};
  const afterEach = new Set<() => void>();

  const middleware =
    (creator: StateCreator<T>): StateCreator<T> =>
    (set, get, api) => {
      type Listener = (s: T, prev: T) => void;
      type Keys = readonly (keyof T)[] | null;
      const listeners = new Map<Listener, Keys>();
      const changedAny = (keys: readonly (keyof T)[], s: T, prev: T) => {
        for (const key of keys) if (s[key] !== prev[key]) return true;
        return false;
      };
      let settling = false;
      const publish = (prev: T) => {
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
        listeners.forEach((keys, listener) => {
          const s = api.getState();
          if (!keys || changedAny(keys, s, prev)) listener(s, prev);
        });
      };
      hear = () => {
        const prev = heard;
        if (prev === null) return;
        heard = null;
        if (api.getState() === prev) return;
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
        if (heardAlone?.(s, prev)) hear();
      });
      const add = (listener: Listener, keys: Keys) => {
        listeners.set(listener, keys);
        return () => {
          listeners.delete(listener);
        };
      };
      api.subscribe = (listener) => add(listener, null);
      const subscribeTo: SubscribeTo<T> = (keys, listener) => add(listener, keys);
      Object.assign(api, { subscribeTo });
      return creator(set, get, api);
    };

  const transaction = (run: () => void) => {
    depth++;
    try {
      run();
    } finally {
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
