import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const counts = { override: 0, address: 0 };

export type ExtensionNewTab = keyof typeof counts;

export const noteExtensionNewTab = (via: ExtensionNewTab, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (counts[via] += 1));

export function takeNewTabPageCounts() {
  const taken = { new_tab_extension_overrides: counts.override, new_tab_extension_addresses: counts.address };
  counts.override = 0;
  counts.address = 0;
  return taken;
}
