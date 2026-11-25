import { create } from "zustand";

export const useDeckStandby = create<{ round: number; wanted: number }>()(() => ({ round: 0, wanted: 0 }));

export const refreshHiddenDeck = () => useDeckStandby.setState((state) => ({ round: state.round + 1 }));

export const wantDeckStandby = () => useDeckStandby.setState((state) => ({ wanted: state.wanted + 1 }));

export const useDeckStandbyWanted = () => useDeckStandby((state) => state.wanted);
