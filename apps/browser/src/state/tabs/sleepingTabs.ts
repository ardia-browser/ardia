import { create } from "zustand";
import type { MemoryPressure } from "./sleepPolicy";

type Lifecycle = {
  discarded: Record<string, true>;
  batterySaver: boolean;
  memoryPressure: MemoryPressure;
};

export const useLifecycle = create<Lifecycle>()(() => ({ discarded: {}, batterySaver: false, memoryPressure: "normal" }));

export const useIsSleeping = (tabId: string) => useLifecycle((l) => !!l.discarded[tabId]);

export const isSleeping = (tabId: string) => !!useLifecycle.getState().discarded[tabId];

export const markSleeping = (tabId: string) => useLifecycle.setState((l) => (l.discarded[tabId] ? l : { discarded: { ...l.discarded, [tabId]: true } }));

export const useMemoryPressure = () => useLifecycle((l) => l.memoryPressure);

const sleptByHand = new Set<string>();

export const noteSleptByHand = (tabId: string) => void sleptByHand.add(tabId);

export const wasSleptByHand = (tabId: string) => sleptByHand.has(tabId);

export const forgetSleptByHand = (tabId: string) => void sleptByHand.delete(tabId);
