import type { ConsentToken } from "./consentPeriod";
import { consentOrNow, countFor } from "./countFor";

const empty = () => ({
  autofill_address_fills_menu: 0,
  autofill_card_fills_menu: 0,
  autofill_fills_failed: 0,
  autofill_card_fills_moved: 0,
  autofill_card_reauth_declined: 0,
  autofill_menu_opens: 0,
  autofill_addresses_added: 0,
  autofill_addresses_edited: 0,
  autofill_cards_added: 0,
  autofill_cards_edited: 0,
  autofill_card_numbers_shown: 0,
  autofill_card_number_reads_failed: 0,
});

let counts = empty();

type AutofillCountField = keyof ReturnType<typeof empty>;

const bump = (field: AutofillCountField, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[field]++);

export const noteAutofillMenuFill = (kind: "address" | "card", filled: boolean, consent?: ConsentToken | null) =>
  bump(!filled ? "autofill_fills_failed" : kind === "card" ? "autofill_card_fills_menu" : "autofill_address_fills_menu", consent);
export const noteAutofillMenuOpen = (consent?: ConsentToken | null) => bump("autofill_menu_opens", consent);
export const noteCardFillMoved = (consent?: ConsentToken | null) => bump("autofill_card_fills_moved", consent);
export const noteCardReauthDeclined = (consent?: ConsentToken | null) => bump("autofill_card_reauth_declined", consent);
export const noteCardNumberShown = (consent?: ConsentToken | null) => bump("autofill_card_numbers_shown", consent);
export const noteCardNumberReadFailed = (consent?: ConsentToken | null) => bump("autofill_card_number_reads_failed", consent);
export const noteAutofillSaved = (kind: "address" | "card", added: boolean, consent?: ConsentToken | null) =>
  bump(kind === "card" ? (added ? "autofill_cards_added" : "autofill_cards_edited") : added ? "autofill_addresses_added" : "autofill_addresses_edited", consent);

export function takeAutofillCounts() {
  const taken = counts;
  counts = empty();
  return taken;
}
