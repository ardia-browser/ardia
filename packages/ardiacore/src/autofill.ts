import { decodeReply } from "./engine/call";
import { nativeModule } from "./nativeModules";
export type SavedAddress = {
  id: string;
  name?: string;
  organization?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
  created: number;
  modified: number;
};
export type AddressInput = Partial<Omit<SavedAddress, "created" | "modified">>;

export type CardNetwork = "visa" | "mastercard" | "amex" | "discover" | "diners" | "jcb" | "unionpay" | "card";
export type SavedCard = {
  id: string;
  name?: string;
  network: CardNetwork;
  last4: string;
  expMonth?: number;
  expYear?: number;
  created: number;
  modified: number;
};
export type CardInput = { id?: string; name?: string; expMonth?: number; expYear?: number };

const Autofill = nativeModule("ArdiaAutofill");

export type CardNumberSummary = { digits: number; network: CardNetwork; complete: boolean; luhn: boolean };
export type CardReveal = ({ revealed: true } & CardNumberSummary) | { revealed: false; declined: boolean };

export type AutofillFieldKind = "address" | "card";
export type AutofillFieldPart = "name" | "organization" | "street" | "city" | "state" | "postalCode" | "country" | "phone" | "email" | "number" | "expiry" | "cvc";
export type AutofillFieldRect = { x: number; y: number; width: number; height: number };
export type AutofillFieldEvent = { tabId: string; epoch?: string } & ({ focused: true; trigger: "focus" | "ask"; kind: AutofillFieldKind; part: AutofillFieldPart; rect: AutofillFieldRect } | { focused: false });
export type AutofillFillResult = { filled: boolean; declined?: boolean };

export const saveCard = async (profile: string, card: CardInput, numberEntry?: string) =>
  (await decodeReply<{ id: string }>(Autofill.saveCard(profile, card, numberEntry ?? null))).id;
