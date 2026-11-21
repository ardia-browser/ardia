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
