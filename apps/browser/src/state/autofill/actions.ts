import { consentToken } from "../telemetry/choice";
import { copyCardEntry, deleteAddress, deleteCard, revealCardInto, revealCardNumber, saveAddress, saveCard, type AddressInput, type SavedAddress, type SavedCard } from "../../platform/autofill";
import { addresses, cards } from "../settings/paneData";
import { load } from "../settings/resources";
import { noteAutofillSaved, noteCardNumberReadFailed, noteCardNumberShown, noteCardReauthDeclined } from "../telemetry/autofillCounts";

export type CardSaveInput = { id?: string; name: string; expMonth?: number; expYear?: number };

const reload = (profile: string) => {
  void load(addresses, [profile], { fresh: true });
  void load(cards, [profile], { fresh: true });
};

export async function saveAddressFromSettings(profile: string, input: AddressInput): Promise<boolean> {
  const consent = consentToken();
  const id = await saveAddress(profile, input).catch(() => null);
  if (!id) return false;
  noteAutofillSaved("address", !input.id, consent);
  reload(profile);
  return true;
}

export async function saveCardFromSettings(profile: string, card: CardSaveInput, numberEntry?: string): Promise<"saved" | "invalid" | "failed"> {
  const consent = consentToken();
  try {
    await saveCard(profile, card, numberEntry);
  } catch (error) {
    return (error as { code?: string })?.code === "ERR_INVALID_NUMBER" ? "invalid" : "failed";
  }
  noteAutofillSaved("card", !card.id, consent);
  reload(profile);
  return "saved";
}

export async function deleteAutofillEntry(profile: string, entry: { kind: "address"; saved: SavedAddress } | { kind: "card"; saved: SavedCard }): Promise<boolean> {
  const done = await (entry.kind === "card" ? deleteCard(profile, entry.saved.id) : deleteAddress(profile, entry.saved.id)).then(
    () => true,
    () => false,
  );
  reload(profile);
  return done;
}

export type CardShown = { shown: true } | { shown: false; declined: boolean };

export async function showCardNumber(profile: string, id: string, entry: string): Promise<CardShown> {
  const consent = consentToken();
  const result = await revealCardInto(profile, id, entry).catch(() => null);
  if (result?.revealed) {
    noteCardNumberShown(consent);
    return { shown: true };
  }
  if (result?.declined) noteCardReauthDeclined(consent);
  return { shown: false, declined: !!result?.declined };
}

export async function readCardNumber(profile: string, id: string): Promise<string | null> {
  const consent = consentToken();
  const number = await revealCardNumber(profile, id).catch(() => null);
  if (number) noteCardNumberShown(consent);
  else noteCardNumberReadFailed(consent);
  return number || null;
}

export const copyCardNumber = async (entry: string) => !!(await copyCardEntry(entry).catch(() => null))?.copied;
