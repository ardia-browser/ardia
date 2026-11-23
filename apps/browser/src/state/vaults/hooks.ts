import { useVaultCodes } from "./codes";
import { useEffect, useReducer } from "react";
import { restVaultMenu, rowsOfMenu, useVaultMenus, type VaultMenu } from "./menu";
import { suggestOf } from "./menuModel";
import { useVaultSaveOffers } from "./saveOffer";
import { useVaultBiometrics, useVaults } from "./store";
export { useVaultSiteItems } from "./store";
import { useBrowser } from "../browser/store";
import { useGeneratedPasswords } from "./generated";
import { codePageTab, frontPageTab } from "./ardiaCodes";
import { useStandaloneCodes } from "./standaloneCodes";
import { usePasskeys } from "./passkeyStore";
import { PENDING_TOTP_MS } from "./pendingTotp";
export { useGeneratedFillable, useKeptGeneratedPasswords } from "./generatedFill";

export const useVaultProviders = () => useVaults((s) => s.providers);
export const useVaultProvider = (id: string) => useVaults((s) => s.providers.find((p) => p.id === id));
export const useVaultTouchID = () => {
  const available = useVaultBiometrics((s) => s.available);
  const asks = useBrowser((s) => s.settings.vaultAskBeforeFilling);
  return available && asks;
};
export const useVaultBiometricsAvailable = () => useVaultBiometrics((s) => s.available);
export const useVaultMenuGlass = () => useBrowser((s) => s.settings.vaultMenuGlass);
export const useVaultCode = (key: string) => useVaultCodes((s) => s[key]);
export const useVaultMenu = (tabId: string) => useVaultMenus((s) => s.menus[tabId] ?? null);
export const useVaultSaveOffer = (tabId: string) => useVaultSaveOffers((s) => s[tabId] ?? null);

function usePendingExpiry(tabId: string | null) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const next = useVaults((s) => {
    const now = Date.now();
    const ends = s.pending.filter((p) => p.tabId === tabId && p.at <= now).map((p) => p.at + PENDING_TOTP_MS).filter((at) => at > now);
    return ends.length ? Math.min(...ends) : null;
  });
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => {
      if (tabId) restVaultMenu(tabId);
      tick();
    }, Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next]);
}

export function useVaultMenuRows(menu: VaultMenu) {
  useVaults((s) => s.revision);
  useBrowser((s) => Object.values(suggestOf(s.settings)).join());
  useGeneratedPasswords((s) => (menu.mode === "search" ? s.list : null));
  useStandaloneCodes((s) => (menu.field === "otp" ? s.items : null));
  usePasskeys((s) => (menu.tabId ? s.offers[menu.tabId] : undefined));
  usePendingExpiry(menu.tabId);
  return rowsOfMenu(menu);
}

export const useFrontPageTab = () => {
  const tabId = useBrowser((s) => frontPageTab(s)?.tabId ?? null);
  const origin = useBrowser((s) => frontPageTab(s)?.origin ?? null);
  return tabId && origin ? { tabId, origin } : null;
};
export const useCodePageTab = (origin: string | null) => useBrowser((s) => (origin ? codePageTab(s, origin) : null));
export const useSeveralProfiles = () => useBrowser((s) => s.profileOrder.length > 1);
