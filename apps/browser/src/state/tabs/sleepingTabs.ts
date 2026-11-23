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

export const useMemoryPressure = () => useLifecycle((l) => l.memoryPressure);
