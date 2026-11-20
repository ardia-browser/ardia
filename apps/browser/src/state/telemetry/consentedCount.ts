import { isSharing, onConsentPeriodChange } from "./choice";

export function consentedCount() {
  let count = 0;
  onConsentPeriodChange(() => (count = 0));
  return {
    note: () => void (isSharing() && count++),
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
