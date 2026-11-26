import { create } from "zustand";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { applePasswordsStatus, type ApplePasswordsState } from "../../platform/applePasswords";

type ApplePasswordsStore = { state: ApplePasswordsState | null };

export const useApplePasswords = create<ApplePasswordsStore>()(() => ({ state: null }));

const OFFERED: ReadonlySet<ApplePasswordsState> = new Set(["connected", "notConnected", "refused", "helperMissing"]);

export const applePasswordsOffered = (state: ApplePasswordsState | null) => PLATFORM_FEATURES.systemPasswordManagers && state !== null && OFFERED.has(state);

export const useApplePasswordsOffered = () => useApplePasswords((s) => applePasswordsOffered(s.state));

export async function loadApplePasswords() {
  if (!PLATFORM_FEATURES.systemPasswordManagers) return;
  const state = await applePasswordsStatus().catch(() => null);
  if (state) useApplePasswords.setState({ state });
}
