import { consentedCount } from "./consentedCount";
import { countFor, type ConsentToken } from "./consentPeriod";

type Side = "above" | "below";

const fresh = () => ({ beside: consentedCount(), fallback: consentedCount() });

let counts: Record<Side, ReturnType<typeof fresh>> | undefined;

export const noteCloseActivation = (consent: ConsentToken | null, side: Side, beside: boolean) =>
  countFor(consent, () => (counts ??= { above: fresh(), below: fresh() })[side][beside ? "beside" : "fallback"].note());

export const takeCloseActivationCounts = () => ({
  close_activated_tab_above: counts?.above.beside.take() ?? 0,
  close_tab_above_fallbacks: counts?.above.fallback.take() ?? 0,
  close_activated_tab_below: counts?.below.beside.take() ?? 0,
  close_tab_below_fallbacks: counts?.below.fallback.take() ?? 0,
});
