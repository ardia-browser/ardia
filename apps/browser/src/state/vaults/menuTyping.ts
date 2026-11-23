import { patchVaultMenu, restingRowOf, rowsOfMenu, vaultMenuOf } from "./menu";

export const TYPED_LONGEST = 256;

export function filterVaultMenu(tabId: string, text: string) {
  const menu = vaultMenuOf(tabId);
  if (!menu || menu.mode !== "matches" || menu.field !== "username") return false;
  const typed = text.trim().slice(0, TYPED_LONGEST);
  if (typed === menu.typed) return true;
  const next = { ...menu, typed };
  patchVaultMenu(tabId, { typed, selected: typed ? (rowsOfMenu(next).length ? 0 : -1) : restingRowOf(next), selectedKey: null, suggestOpen: false, error: null }, menu.seq);
  return true;
}
