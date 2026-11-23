import type { AddressInput, SavedAddress, SavedCard } from "../../autofill";
import type { Profile } from "../wire";

export type AutofillCalls = {
  "autofill.settings": [Profile, { addresses: boolean; cards: boolean }];
  "autofill.setSettings": [Profile & { addresses?: boolean; cards?: boolean }, null];
  "autofill.addresses": [Profile, { addresses: SavedAddress[] }];
  "autofill.saveAddress": [Profile & { address: AddressInput }, { id: string }];
  "autofill.cards": [Profile, { cards: SavedCard[] }];
  "autofill.remove": [Profile & { id: string }, { ok: true }];
  "autofill.cardNumber": [Profile & { id: string }, { number?: string | null }];
  "autofill.showSuggestions": [{ tabId: string; passwords: boolean }, boolean];
};

export type AutofillEvents = {};
