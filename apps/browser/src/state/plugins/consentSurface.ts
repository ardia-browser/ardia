import { confirmConsentRequest, dismissConsentRequest } from "./lifecycle";
import { currentPlugins, type PluginsStore } from "./store";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;
export type ConsentOwner = "onboarding" | "settings";

let asking: { name: string; before: number | null } | null = null;
let onboarding: { id: number; alive: () => boolean; windowId: string | null } | null = null;

export function askConsentInOnboarding<T>(name: string, windowId: string | null, alive: () => boolean, ask: () => T): { result: T; id: number | null } {
  const before = currentPlugins().consent?.id ?? null;
  asking = { name, before };
  let result: T;
  try {
    result = ask();
  } finally {
    asking = null;
  }
  const request = currentPlugins().consent;
  const id = request && request.name === name && request.id !== before ? request.id : null;
  if (id !== null) onboarding = { id, alive, windowId };
  return { result, id };
}

let settingsPresenters = 0;

const onboardingOwned = (consent: ConsentRequest) => onboarding?.id === consent.id || (consent.name === asking?.name && consent.id !== asking.before);

const orphaned = (consent: ConsentRequest) => {
  if (onboarding?.id === consent.id) return !onboarding.alive();
  return !onboardingOwned(consent) && settingsPresenters === 0;
};

export function presentSettingsConsent(): () => void {
  settingsPresenters += 1;
  return () => {
    settingsPresenters -= 1;
    const consent = currentPlugins().consent;
    if (consent && settingsPresenters === 0 && !onboardingOwned(consent)) dismissConsentRequest(consent.id);
  };
}

export function releaseOrphanedConsent(): boolean {
  const consent = currentPlugins().consent;
  return !!consent && orphaned(consent) && dismissConsentRequest(consent.id);
}

export function consentOwner(consent: ConsentRequest | null): ConsentOwner | null {
  if (!consent || orphaned(consent)) return null;
  return onboardingOwned(consent) ? "onboarding" : "settings";
}

const owns = (owner: ConsentOwner, id: number) => {
  const consent = currentPlugins().consent;
  return consent?.id === id && consentOwner(consent) === owner;
};

export const confirmConsentAs = (owner: ConsentOwner, id: number): boolean => owns(owner, id) && confirmConsentRequest(id);

export const dismissConsentAs = (owner: ConsentOwner, id: number): boolean => owns(owner, id) && dismissConsentRequest(id);

export const ownsConsent = owns;


export function releaseOnboardingConsent(): boolean {
  const consent = currentPlugins().consent;
  return !!consent && onboarding?.id === consent.id && dismissConsentRequest(consent.id);
}

export function cancelConsentOnEscape(windowId: string, settingsWindowId: string): boolean {
  const consent = currentPlugins().consent;
  const owner = consentOwner(consent);
  if (!consent || !owner) return false;
  const shownIn = owner === "onboarding" ? onboarding?.windowId : settingsWindowId;
  return shownIn === windowId && dismissConsentAs(owner, consent.id);
}
