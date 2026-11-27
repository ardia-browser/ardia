import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { OnboardingSection } from "../../state/onboarding/sections";
import type { PreviewId } from "./previews";

export type SectionPlace = OnboardingSection & { active: boolean; key: string };

export const SectionContext = createContext<SectionPlace>({ step: "source", sub: 0, id: "source", active: true, key: "source" });

export const useSection = () => useContext(SectionContext);

export type MockFocus = { hover: (id: PreviewId, on: boolean) => void; choose: (key: string, id: PreviewId) => void; settle: (key: string, id: PreviewId | null) => void };

export type MockFocusStore = MockFocus & { show(sectionKey: string | null): void; current(): PreviewId | null; subscribe(listener: () => void): () => void };

export function createMockFocus(): MockFocusStore {
  let section: string | null = null;
  let hovered: PreviewId | null = null;
  let settled: { key: string; id: PreviewId | null } | null = null;
  let shown: PreviewId | null = null;
  const listeners = new Set<() => void>();
  const update = (change: () => void) => {
    change();
    const next = hovered ?? (settled?.key === section ? settled.id : null);
    if (next === shown) return;
    shown = next;
    for (const listener of listeners) listener();
  };
  return {
    hover: (id, on) => {
      if (on) update(() => (hovered = id));
    },
    choose: (key, id) =>
      update(() => {
        hovered = null;
        settled = { key, id };
      }),
    settle: (key, id) => update(() => (settled = { key, id })),
    show: (key) =>
      update(() => {
        section = key;
        hovered = null;
      }),
    current: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const MockFocusContext = createContext<MockFocusStore>(createMockFocus());

export const useSharedMockFocus = (): MockFocus => useContext(MockFocusContext);

export function useMockFocusValue() {
  const store = useContext(MockFocusContext);
  return useSyncExternalStore(store.subscribe, store.current);
}

export type FlowShown = { key: string; actions: ReactNode; preview: ReactNode | null };

export type FlowSlots = {
  publish(next: FlowShown): void;
  shown(): FlowShown | null;
  subscribe(listener: () => void): () => void;
  forward: { run: (() => void) | null };
  subscribeForward(listener: () => void): () => void;
};

export function createFlowSlots(): FlowSlots {
  let shown: FlowShown | null = null;
  let run: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const forwardListeners = new Set<() => void>();
  return {
    publish(next) {
      shown = next;
      for (const listener of listeners) listener();
    },
    shown: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    forward: {
      get run() {
        return run;
      },
      set run(next) {
        const changed = !run !== !next;
        run = next;
        if (changed) for (const listener of forwardListeners) listener();
      },
    },
    subscribeForward(listener) {
      forwardListeners.add(listener);
      return () => void forwardListeners.delete(listener);
    },
  };
}

export function publishedForward(slots: FlowSlots, currentKey: string | null): (() => void) | null {
  const owner = slots.shown()?.key;
  if (!currentKey || !owner || (owner !== currentKey && !owner.startsWith(`${currentKey}:`))) return null;
  return slots.forward.run;
}

export const FlowSlotsContext = createContext<FlowSlots>(createFlowSlots());

export function useFlowShown() {
  const slots = useContext(FlowSlotsContext);
  return useSyncExternalStore(slots.subscribe, slots.shown);
}

export const useFlowSlots = () => useContext(FlowSlotsContext);

export function useCanGoForward(slots: FlowSlots, currentKey: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unpublished = slots.subscribe(listener);
      const unforwarded = slots.subscribeForward(listener);
      return () => {
        unpublished();
        unforwarded();
      };
    },
    [slots],
  );
  return useSyncExternalStore(subscribe, () => !!publishedForward(slots, currentKey));
}

export const FlowPreviewShownContext = createContext(true);

export const useFlowPreviewShown = () => useContext(FlowPreviewShownContext);
