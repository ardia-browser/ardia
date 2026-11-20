import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useBrowser, type BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { currentBasePalette, useBasePalette } from "../config/basePalette";
import type { BasePalette } from "../../lib/themeFile";

type Readable<S> = { getState(): S; subscribe(listener: (s: S, prev: S) => void): () => void };

const subscribeOf = <S,>(store: Readable<S>): Readable<S>["subscribe"] => (store.subscribe as { unprobed?: Readable<S>["subscribe"] }).unprobed ?? store.subscribe;

export const watchBrowser = (listener: (s: BrowserState, prev: BrowserState) => void): (() => void) => subscribeOf(useBrowser)(listener);

const watchers = new Map<string, Set<() => void>>();
let listening = false;

function wake(s: BrowserState, prev: BrowserState) {
  if (s.tabs === prev.tabs) return;
  for (const [id, listeners] of watchers) {
    if (s.tabs[id] === prev.tabs[id]) continue;
    for (const listener of [...listeners]) listener();
  }
}

export function watchTab(tabId: string, listener: () => void): () => void {
  if (!listening) {
    listening = true;
    subscribeOf(useBrowser)(wake);
  }
  let listeners = watchers.get(tabId);
  if (!listeners) watchers.set(tabId, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && watchers.get(tabId) === listeners) watchers.delete(tabId);
  };
}

export const watchedTabs = () => watchers.size;

export function tabSnapshot<T>(tabId: string, select: (tab: Tab | undefined) => T, equal: (a: T, b: T) => boolean = Object.is): () => T {
  let seen: { tab: Tab | undefined; value: T } | null = null;
  return () => {
    const tab = useBrowser.getState().tabs[tabId];
    if (seen && seen.tab === tab) return seen.value;
    const value = select(tab);
    seen = { tab, value: seen && equal(seen.value, value) ? seen.value : value };
    return seen.value;
  };
}

export function useTabValue<T>(tabId: string, select: (tab: Tab | undefined) => T, equal?: (a: T, b: T) => boolean): T {
  const [subscribe, get] = useMemo(() => [(listener: () => void) => watchTab(tabId, listener), tabSnapshot(tabId, select, equal)] as const, [tabId]);
  return useSyncExternalStore(subscribe, get);
}

const inert = Object.assign((_: () => void) => () => {}, { inert: true });

const spaceWatchers = new Set<() => void>();
let watchingSpaces = false;

function watchSpaces(listener: () => void): () => void {
  if (!watchingSpaces) {
    watchingSpaces = true;
    subscribeOf(useBrowser)((s, prev) => {
      if (s.spaces !== prev.spaces) for (const l of [...spaceWatchers]) l();
    });
  }
  spaceWatchers.add(listener);
  return () => spaceWatchers.delete(listener);
}

export function useSpacesValue<T>(key: string, select: (spaces: BrowserState["spaces"]) => T): T {
  const read = () => select(useBrowser.getState().spaces);
  const [value, setValue] = useState(read);
  useEffect(() => {
    setValue(read());
    return watchSpaces(() => setValue(read()));
  }, [key]);
  return value;
}

const lookWatchers = new Set<() => void>();
let watchingLooks = false;

function watchLooks(listener: () => void): () => void {
  if (!watchingLooks) {
    watchingLooks = true;
    subscribeOf(useBrowser)((s, prev) => {
      if (s.spaces !== prev.spaces || s.ui.appDark !== prev.ui.appDark || s.settings !== prev.settings) for (const l of [...lookWatchers]) l();
    });
    useBasePalette.subscribe((s, prev) => {
      if (s.palette !== prev.palette) for (const l of [...lookWatchers]) l();
    });
  }
  lookWatchers.add(listener);
  return () => lookWatchers.delete(listener);
}

type LookInputs = { profile: BrowserState["spaces"][string] | undefined; appDark: boolean; settings: BrowserState["settings"]; palette: BasePalette | null };

type Look<T> = (profile: LookInputs["profile"], appDark: boolean, settings: LookInputs["settings"], palette: BasePalette | null) => T;

function lookSnapshot<T>(spaceId: string, look: Look<T>): () => T {
  let seen: (LookInputs & { value: T }) | null = null;
  return () => {
    const s = useBrowser.getState();
    const space = s.spaces[spaceId];
    const palette = currentBasePalette();
    if (seen && seen.profile === space && seen.appDark === s.ui.appDark && seen.settings === s.settings && seen.palette === palette) return seen.value;
    seen = { profile: space, appDark: s.ui.appDark, settings: s.settings, palette, value: look(space, s.ui.appDark, s.settings, palette) };
    return seen.value;
  };
}

export function useLookValue<T>(spaceId: string, look: Look<T>): T {
  const get = useMemo(() => lookSnapshot(spaceId, look), [spaceId]);
  return useSyncExternalStore(watchLooks, get);
}

type Settings = BrowserState["settings"];

function settingSnapshot<T>(select: (settings: Settings) => T): () => T {
  let seen: { settings: Settings; value: T } | null = null;
  return () => {
    const settings = useBrowser.getState().settings;
    if (seen && seen.settings === settings) return seen.value;
    seen = { settings, value: select(settings) };
    return seen.value;
  };
}

export function useSettingValue<T>(select: (settings: Settings) => T): T {
  const get = useMemo(() => settingSnapshot(select), [select]);
  return useSyncExternalStore(watchLooks, get);
}

export function useStoreWhile<S, T>(store: Readable<S>, live: boolean, select: (s: S) => T): T {
  return useSyncExternalStore(live ? subscribeOf(store) : inert, () => select(store.getState()));
}

export const useBrowserWhile = <T,>(live: boolean, select: (s: BrowserState) => T): T => useStoreWhile(useBrowser, live, select);

export const shallowEqual = <T extends Record<string, unknown>>(a: T, b: T) => {
  for (const key in a) if (!Object.is(a[key], b[key])) return false;
  for (const key in b) if (!(key in a)) return false;
  return true;
};
