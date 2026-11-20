import { isSharing, onConsentPeriodChange, stillValid, type ConsentToken } from "./choice";

export function consentedCount() {
  let count = 0;
  onConsentPeriodChange(() => (count = 0));
  return {
    note: (consent?: ConsentToken | null) => void ((consent === undefined ? isSharing() : stillValid(consent)) && count++),
    take: () => {
      const taken = count;
      count = 0;
      return taken;
    },
  };
}

export function consentedMax() {
  let most = 0;
  onConsentPeriodChange(() => (most = 0));
  return {
    note: (value: number) => void (isSharing() && (most = Math.max(most, value))),
    take: () => {
      const taken = most;
      most = 0;
      return taken;
    },
  };
}
