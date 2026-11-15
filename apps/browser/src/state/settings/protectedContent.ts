import { useSyncExternalStore } from "react";
import { hasProtectedContentSetting, onProtectedContent, protectedContentState, setProtectedContent, type ProtectedContentState } from "../../platform/protectedContent";

export type { ProtectedContentState };

export const protectedContentToggleShown = hasProtectedContentSetting;

let current: ProtectedContentState | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  if (!listeners.size) current = protectedContentState();
  listeners.add(listener);
  const subscription = onProtectedContent((state) => {
    current = state;
    for (const each of [...listeners]) each();
  });
  return () => {
    listeners.delete(listener);
    subscription.remove();
  };
}

const snapshot = () => (current ??= protectedContentState());

export const useProtectedContent = () => useSyncExternalStore(subscribe, snapshot);

export async function setPlayProtectedContent(on: boolean) {
  const state = await setProtectedContent(on);
  if (!state) return;
  current = state;
  for (const each of [...listeners]) each();
}

export function describeProtectedContent(state: ProtectedContentState | null): string {
  const named = state?.version ? `Widevine ${state.version}` : "Widevine";
  if (!state) return "Checking…";
  if (!state.enabled) {
    if (state.restartNeeded) return `${named} stops after you restart Ardia.`;
    return "Lets Netflix, Spotify and other sites play protected video and music. Ardia downloads Google's Widevine module when you turn this on; DRM plays after a restart.";
  }
  if (state.component === "failed") return "Widevine couldn't be downloaded. Ardia tries again later.";
  if (state.component === "checking" || state.component === "downloading" || !state.version) return "Downloading Widevine… DRM plays after you restart Ardia.";
  if (state.playsNow) return `${named} is on.`;
  return `${named} is ready. Restart Ardia to play DRM-protected content.`;
}
