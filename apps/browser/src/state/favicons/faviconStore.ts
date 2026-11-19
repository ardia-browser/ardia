import { create } from "zustand";
import type { IconTheme } from "../../platform/favicons";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { batchStoreUpdates, useBrowser } from "../browser/store";

export type Icons = {
  pages: Record<string, string | null>;
  srcs: Record<string, string>;
  appearances: Record<string, [string, string]>;
};

export const EMPTY_ICONS: Icons = { pages: {}, srcs: {}, appearances: {} };
export const MAX_ICONS = 3000;

export type Favicons = {
  profiles: Record<string, Icons>;
  themes: Record<string, IconTheme | null>;
};

export const useFavicons = create<Favicons>()(() => ({ profiles: {}, themes: {} }));

export const knownFaviconTheme = (uri: string) => useFavicons.getState().themes[uri];

export const cacheKey = (profileId: string) => (isIncognitoProfile(profileId) ? profileId : engineProfile(useBrowser.getState(), profileId));

type Change = (f: Favicons) => Favicons;
const FLUSH_MS = 16;
const changes: Change[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export const faviconChangesQueued = () => changes.length > 0;

export function queueFaviconChange(change: Change, now = false) {
  changes.push(change);
  if (now) flushFaviconChanges();
  else flushTimer ??= setTimeout(flushFaviconChanges, FLUSH_MS);
}

export function flushFaviconChanges() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  const all = changes.splice(0);
  if (all.length) batchStoreUpdates(() => useFavicons.setState((f) => all.reduce((s, change) => change(s), f)));
}

export function updateIcons(key: string, change: (icons: Icons) => Icons, now = false) {
  queueFaviconChange((f) => {
    const before = f.profiles[key] ?? EMPTY_ICONS;
    const after = change(before);
    return after === before ? f : { ...f, profiles: { ...f.profiles, [key]: after } };
  }, now);
}

export const capped = <T,>(map: Record<string, T>, key: string, value: T): Record<string, T> =>
  Object.keys(map).length >= MAX_ICONS ? { [key]: value } : { ...map, [key]: value };

export const hasNoIcon = (url: string) => /^(?:ardia|ardia-favicon|about|blob|data|javascript):/i.test(url);
