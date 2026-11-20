import { call, on, saveCard, type AddressInput, type AutofillFieldEvent, type AutofillFieldKind, type AutofillFieldPart, type AutofillFieldRect, type CardNetwork, type CardNumberSummary, type SavedAddress, type SavedCard } from "@ardia/ardiacore";

export { saveCard };
export type { SavedAddress, SavedCard, CardNetwork, AddressInput, CardNumberSummary, AutofillFieldEvent, AutofillFieldKind, AutofillFieldPart, AutofillFieldRect };
export type AutofillToggle = "passwords" | "addresses" | "cards";

export const getAutofillSettings = (profile = "") => call("autofill.settings", { profile });
export const setAutofillSettings = (settings: { addresses?: boolean; cards?: boolean }, profile = "") =>
  call("autofill.setSettings", { profile, ...settings });
export const listAddresses = async (profile: string) => (await call("autofill.addresses", { profile })).addresses;
export const saveAddress = async (profile: string, address: AddressInput) => (await call("autofill.saveAddress", { profile, address })).id;
export const deleteAddress = async (profile: string, id: string) => {
  await call("autofill.remove", { profile, id });
};
export const listCards = async (profile: string) => (await call("autofill.cards", { profile })).cards;
export const deleteCard = async (profile: string, id: string) => {
  await call("autofill.remove", { profile, id });
};
export const revealCardNumber = async (profile: string, id: string) => (await call("autofill.cardNumber", { profile, id })).number ?? null;
export const revealCardInto = (profile: string, id: string, entry: string) => call("autofill.revealCard", { profile, id, entry });
export const copyCardEntry = (entry: string) => call("autofill.copyCard", { entry });
export type AutofillFill = { filled: boolean; declined?: boolean; moved?: boolean };
export const fillAutofillEntry = (tabId: string, kind: AutofillFieldKind, id: string): Promise<AutofillFill> => call("autofill.fill", { tabId, kind, id });
export const onAutofillField = (listener: (event: AutofillFieldEvent) => void) => on("autofill.field", listener);
export const onAutofillMenuKey = (listener: (event: { tabId: string; key: string; epoch?: string }) => void) => on("autofill.menuKey", listener);
export const claimAutofillMenuKeys = (tabId: string, claim: boolean) => call("autofill.claimMenuKeys", { tabId, claim });
export const showAutofillSuggestions = (tabId: string, kind: "passwords" | "field") =>
  call("autofill.showSuggestions", { tabId, passwords: kind === "passwords" });
