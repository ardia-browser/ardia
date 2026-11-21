import type { StateCreator } from "zustand";

export function actionsApart<T extends object>(creator: StateCreator<T>): StateCreator<T> {
  return (set, get, api) => {
    const actions: Record<string, unknown> = {};
    const rooted = (state: T): T => (Object.getPrototypeOf(state) === actions ? state : (Object.assign(Object.create(actions), state) as T));
    const setApart = ((partial: T | Partial<T> | ((s: T) => T | Partial<T>), replace?: boolean) => {
      const next = typeof partial === "function" ? partial(get()) : partial;
      if (replace) return set(rooted(next as T), true);
      if (next === get()) return;
      set(Object.assign(Object.create(actions), get(), next) as T, true);
    }) as typeof set;
    api.setState = setApart;
    const initial = creator(setApart, get, api) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(initial)) (typeof initial[key] === "function" ? actions : data)[key] = initial[key];
    return Object.assign(Object.create(actions), data) as T;
  };
}
