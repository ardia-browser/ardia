import { consentToken, type ConsentToken } from "../telemetry/choice";
import { claimChromeDropdowns, closeChromeDropdown, type ChromeDropdownShown } from "./chromeDropdown";
import { dismissVaultMenu, rowsOfMenu, useVaultMenus, vaultMenuOf, type VaultMenu } from "./menu";
import { hasFillRow } from "./menuModel";
import { refreshVault } from "../../platform/vaults";
import { ARDIA_PROVIDER } from "./ardia";
import { useVaults } from "./store";
import { noteChromeDropdownHidden, noteVaultMenuYieldedToChrome } from "../telemetry/vaultCounts";

const VAULT_MENU_DROPDOWNS = ["login", "history"] as const;
const vaultReplacesDropdown = (kinds: readonly ChromeDropdownShown[]) => kinds.length > 0 && kinds.every((k) => VAULT_MENU_DROPDOWNS.some((own) => own === k));

export function menuLogins(menu: VaultMenu): string[] {
  const names = new Set<string>();
  for (const row of rowsOfMenu(menu.mode === "matches" ? menu : { ...menu, mode: "matches", query: "" })) if (row.kind === "login") names.add(row.item.username.trim().toLowerCase());
  return [...names];
}

export const coversChromeLogins = (menu: VaultMenu, logins: readonly string[]) => {
  const own = new Set(menuLogins(menu));
  return logins.every((login) => own.has(login.trim().toLowerCase()));
};

function yieldToChrome(tabId: string, missedLogins: boolean, consent: ConsentToken | null) {
  noteVaultMenuYieldedToChrome(consent);
  dismissVaultMenu(tabId);
  if (missedLogins) void refreshVault(ARDIA_PROVIDER).catch(() => null);
}

function settleWithChromeDropdown(tabId: string, menu: VaultMenu, kinds: readonly ChromeDropdownShown[], logins: readonly string[], consent: ConsentToken | null) {
  if (menu.busy) return void closeChromeDropdown(tabId, consent);
  if (kinds.includes("other") || kinds.includes("passkey")) return yieldToChrome(tabId, false, consent);
  if (kinds.includes("login") && !coversChromeLogins(menu, logins)) return yieldToChrome(tabId, true, consent);
  if (vaultReplacesDropdown(kinds) || menu.onDemand || hasFillRow(rowsOfMenu(menu))) return void closeChromeDropdown(tabId, consent);
  yieldToChrome(tabId, false, consent);
}

export function noteAutofillSuggestions(tabId: string, count: number, kinds: readonly ChromeDropdownShown[] = [], hidden = false, logins: readonly string[] = []) {
  const consent = consentToken();
  if (hidden) return noteChromeDropdownHidden(consent);
  const menu = vaultMenuOf(tabId);
  if (count > 0 && menu) settleWithChromeDropdown(tabId, menu, kinds, logins, consent);
}

async function claimForVaultMenu(tabId: string, consent: ConsentToken | null) {
  const menu = vaultMenuOf(tabId);
  const { showing, logins } = await claimChromeDropdowns(tabId, "vaultMenu", menu ? VAULT_MENU_DROPDOWNS : [], menu ? menuLogins(menu) : [], consent);
  const now = vaultMenuOf(tabId);
  if (now && now.seq === menu?.seq && showing.length) settleWithChromeDropdown(tabId, now, showing, logins, consent);
}

export function startVaultMenuDropdowns() {
  const claimOpenMenus = (tabIds: Iterable<string>, consent: ConsentToken | null) => {
    for (const tabId of tabIds) void claimForVaultMenu(tabId, consent);
  };
  const stopMenus = useVaultMenus.subscribe((s, prev) => {
    if (s.menus !== prev.menus) claimOpenMenus(new Set([...Object.keys(s.menus), ...Object.keys(prev.menus)]), consentToken());
  });
  const stopItems = useVaults.subscribe((s, prev) => {
    if (s.items !== prev.items || s.providers !== prev.providers) claimOpenMenus(Object.keys(useVaultMenus.getState().menus), consentToken());
  });
  return () => {
    stopMenus();
    stopItems();
  };
}
