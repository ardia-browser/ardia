import { vaultsOnForTab } from "./enabled";
import { dropVaultTouchGrant, type VaultTouchIDStatus } from "../../platform/vaults";
import { activateVaultRow, BY_TOUCH_ID } from "./fill";
import { patchVaultMenu, restVaultMenu, rowsOfMenu, vaultMenuOf, type VaultMenu, type VaultTouchPhase } from "./menu";
import type { VaultRow } from "./menuModel";
import { vaultProviderOf } from "./store";
import { touchScope } from "./touchScopes";

let armed: { tabId: string; seq: number } | null = null;

export function armVaultTouchID(tabId: string, menuSeq: number | null) {
  if (menuSeq !== null && vaultsOnForTab(tabId)) armed = { tabId, seq: menuSeq };
  else if (armed?.tabId === tabId) armed = null;
}

export const touchIDGlyphShown = (phase: VaultTouchPhase) => phase !== "unavailable" && phase !== "lockout";

export const isTouchRow = (row: VaultRow | undefined): row is VaultRow => !!row;

const usesOwnerGrant = (row: VaultRow) =>
  row.kind === "login" || row.kind === "otp" || (row.kind === "unlock" && !!vaultProviderOf(row.provider)?.touchUnlock);

function touchRowOf(menu: VaultMenu): VaultRow | null {
  if (menu.hidden || menu.busy || !touchIDGlyphShown(menu.touch)) return null;
  const row = rowsOfMenu(menu)[menu.selected];
  return row && isTouchRow(row) ? row : null;
}

const unusedGrant = () => void dropVaultTouchGrant().catch(() => undefined);

export function touchScopeOf(tabId: string, menu: VaultMenu): string {
  const row = touchRowOf(menu);
  if (row?.kind === "unlock") return touchScope.unlock(row.provider);
  if (row?.kind === "login" && row.item.passkey) return touchScope.passkey(row.item.passkey.requestId, row.item.passkey.credentialId);
  if (row?.kind === "login" || row?.kind === "otp") return touchScope.fill(row.item.provider, row.item.id, menu.origin, tabId);
  return "";
}

export function grantVaultTouch(tabId: string, menuSeq: number): boolean {
  restVaultMenu(tabId);
  const menu = vaultMenuOf(tabId);
  if (!armed || armed.tabId !== tabId || armed.seq !== menuSeq || !menu || menu.seq !== menuSeq || menu.busy) {
    unusedGrant();
    return false;
  }
  const row = touchRowOf(menu);
  if (!row) {
    unusedGrant();
    patchVaultMenu(tabId, { touch: "off", touchRearms: menu.touchRearms + 1 }, menuSeq);
    return false;
  }
  if (!usesOwnerGrant(row)) unusedGrant();
  patchVaultMenu(tabId, { touch: "granted" }, menuSeq);
  activateVaultRow(tabId, row, BY_TOUCH_ID);
  return true;
}

export function noteVaultTouchStatus(tabId: string, menuSeq: number, status: VaultTouchIDStatus) {
  const menu = vaultMenuOf(tabId);
  if (!menu || menu.seq !== menuSeq) return;
  switch (status) {
    case "ready":
      if (menu.touch === "granted" && menu.busy) return;
      return patchVaultMenu(tabId, { touch: "ready" }, menuSeq);
    case "retry":
      return patchVaultMenu(tabId, { touch: "retry", touchRetries: menu.touchRetries + 1 }, menuSeq);
    case "granted":
      return void grantVaultTouch(tabId, menuSeq);
    case "unavailable":
    case "lockout":
      return patchVaultMenu(tabId, { touch: status }, menuSeq);
  }
}
