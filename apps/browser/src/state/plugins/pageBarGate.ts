import { create } from "zustand";

export const usePageBarGate = create<{ on: boolean }>()(() => ({ on: false }));

export const pageBarsWanted = () => usePageBarGate.getState().on;

export function setPageBarsWanted(on: boolean) {
  if (pageBarsWanted() !== on) usePageBarGate.setState({ on });
}
