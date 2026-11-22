import { settleInstall } from "./installWaiters";
import { confirmConsentRequest, dismissConsentRequest } from "./lifecycle";
import { currentPlugins, type PluginsStore } from "./store";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;
export type ConsentOwner = "onboarding" | "settings";

let onboarding: { id: number; alive: () => boolean; windowId: string | null } | null = null;

export function claimOnboardingConsent(id: number, windowId: string | null, alive: () => boolean): boolean {
  if (currentPlugins().consent?.id !== id || !alive()) return false;
  onboarding = { id, alive, windowId };
  return true;
}

let settingsPresenters = 0;

const onboardingOwned = (consent: ConsentRequest) => onboarding?.id === consent.id;

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

export const CONFIRM_REFUSED = "Can't install it right now.";

export function confirmConsentAs(owner: ConsentOwner, id: number): boolean {
  if (!owns(owner, id)) return false;
  if (confirmConsentRequest(id)) return true;
  const still = currentPlugins().consent;
  if (still?.id === id) {
    settleInstall(still.name, { ok: false, reason: CONFIRM_REFUSED });
    dismissConsentRequest(id);
  }
  return false;
}

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
