import { useSyncExternalStore } from "react";
import type { ProfileTheme } from "../../state/browser/types";

type Live = { theme: ProfileTheme | null } | null;

let live: Live = null;
const listeners = new Set<() => void>();

export function showLiveTheme(theme: ProfileTheme | null | undefined) {
  const next = theme === undefined ? null : { theme };
  if (next === null && live === null) return;
  live = next;
  for (const listener of listeners) listener();
}

export const useLiveTheme = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => live,
  );
