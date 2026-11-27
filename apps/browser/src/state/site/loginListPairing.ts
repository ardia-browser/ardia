import { patchPage } from "../tabs/pageState";
import { cancelPairing, startApplePasswordsPairing } from "./applePasswords";

export function pairFromLoginList(tabId: string) {
  void startApplePasswordsPairing(null);
  patchPage(tabId, { applePasswordsPairing: true });
}

export const loginListPairingDone = (tabId: string) => patchPage(tabId, { applePasswordsPairing: false });

export function cancelLoginListPairing(tabId: string) {
  cancelPairing();
  loginListPairingDone(tabId);
}
