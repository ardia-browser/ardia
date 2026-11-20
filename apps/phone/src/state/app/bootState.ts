import { create } from "zustand";
import type { ImportOutcome } from "../legacy/importer";

export type BootState = { ready: boolean; failures: number; busy: boolean; outcome: ImportOutcome | null };

export const useBoot = create<BootState>()(() => ({ ready: false, failures: 0, busy: false, outcome: null }));
