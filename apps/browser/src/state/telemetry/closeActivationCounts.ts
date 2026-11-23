import { consentedCount } from "./consentedCount";
import { countFor, type ConsentToken } from "./consentPeriod";

type Kind = "above" | "fallback";

let counts: Record<Kind, ReturnType<typeof consentedCount>> | undefined;

const started = () => (counts ??= { above: consentedCount(), fallback: consentedCount() });

export const noteCloseActivation = (consent: ConsentToken | null, kind: Kind) => countFor(consent, () => started()[kind].note());

export const takeCloseActivationCounts = () => ({
  close_activated_tab_above: counts?.above.take() ?? 0,
  close_tab_above_fallbacks: counts?.fallback.take() ?? 0,
});
