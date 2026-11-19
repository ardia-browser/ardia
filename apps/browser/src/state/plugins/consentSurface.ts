import { currentPlugins, type PluginsStore } from "./store";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;

let asking: string | null = null;
let onboardingRequest: ConsentRequest | null = null;

export function askConsentInOnboarding<T>(name: string, ask: () => T): { result: T; release: () => void } {
  asking = name;
  let result: T;
  try {
    result = ask();
  } finally {
    asking = null;
  }
  const request = currentPlugins().consent;
  const mine = request?.name === name ? request : null;
  if (mine) onboardingRequest = mine;
  return {
    result,
    release: () => {
      if (mine && onboardingRequest === mine) onboardingRequest = null;
    },
  };
}

export const onboardingOwnsConsent = (consent: ConsentRequest | null): consent is ConsentRequest => !!consent && consent === onboardingRequest;

export const settingsOwnsConsent = (consent: ConsentRequest | null): boolean => !!consent && consent !== onboardingRequest && consent.name !== asking;
