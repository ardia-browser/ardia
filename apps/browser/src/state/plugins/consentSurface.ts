import { confirmConsentRequest, dismissConsentRequest } from "./lifecycle";
import { currentPlugins, type PluginsStore } from "./store";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;
export type ConsentOwner = "onboarding" | "settings";

let asking: string | null = null;
let onboarding: { id: number; alive: () => boolean } | null = null;

export function askConsentInOnboarding<T>(name: string, alive: () => boolean, ask: () => T): { result: T; id: number | null } {
  asking = name;
  let result: T;
  try {
    result = ask();
  } finally {
    asking = null;
  }
  const request = currentPlugins().consent;
  const id = request?.name === name ? request.id : null;
  if (id !== null) onboarding = { id, alive };
  return { result, id };
}

const orphaned = (consent: ConsentRequest) => onboarding?.id === consent.id && !onboarding.alive();

export function consentOwner(consent: ConsentRequest | null): ConsentOwner | null {
  if (!consent || orphaned(consent)) return null;
  if (onboarding?.id === consent.id || consent.name === asking) return "onboarding";
  return "settings";
}

const owns = (owner: ConsentOwner, id: number) => {
  const consent = currentPlugins().consent;
  return consent?.id === id && consentOwner(consent) === owner;
};

export const confirmConsentAs = (owner: ConsentOwner, id: number): boolean => owns(owner, id) && confirmConsentRequest(id);

export const dismissConsentAs = (owner: ConsentOwner, id: number): boolean => owns(owner, id) && dismissConsentRequest(id);

export const ownsConsent = owns;

export function dismissOrphanedConsent(): boolean {
  const consent = currentPlugins().consent;
  return !!consent && orphaned(consent) && dismissConsentRequest(consent.id);
}

export function releaseOnboardingConsent(): boolean {
  const consent = currentPlugins().consent;
  return !!consent && onboarding?.id === consent.id && dismissConsentRequest(consent.id);
}
