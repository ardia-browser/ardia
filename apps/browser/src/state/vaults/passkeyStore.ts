import { create } from "zustand";
import type { VaultItem, VaultPasskey, VaultPasskeyRequest } from "../../platform/vaults";

export type PasskeySheet = VaultPasskeyRequest & {
  seq: number;
  selected: string | null;
  busy: boolean;
  error: string | null;
  target: string;
  targets: string[];
  targetNote: string | null;
};

type PasskeysState = {
  sheets: Record<string, PasskeySheet>;
  offers: Record<string, VaultPasskeyRequest>;
  list: VaultPasskey[] | null;
};

export const usePasskeys = create<PasskeysState>()(() => ({ sheets: {}, offers: {}, list: null }));

const NONE: VaultItem[] = [];
const offerItems = new WeakMap<VaultPasskeyRequest, VaultItem[]>();

export function passkeyItemsOf(offer: VaultPasskeyRequest): VaultItem[] {
  const known = offerItems.get(offer);
  if (known) return known;
  const items = offer.passkeys.map(
    (p): VaultItem => ({
      provider: p.provider,
      id: `passkey:${p.id}`,
      title: p.userName || p.displayName || offer.rpId,
      username: p.userName || p.displayName,
      urls: [`https://${offer.rpId}`],
      passkey: { requestId: offer.requestId, credentialId: p.id },
    }),
  );
  offerItems.set(offer, items);
  return items;
}

export function offeredPasskeys(tabId: string | null | undefined, origin: string): VaultItem[] {
  const offer = tabId ? usePasskeys.getState().offers[tabId] : undefined;
  return offer && offer.origin === origin ? passkeyItemsOf(offer) : NONE;
}
