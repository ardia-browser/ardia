import { openVaultItem, type VaultProviderState } from "../../platform/vaults";
import { consentToken } from "../telemetry/consentPeriod";
import { noteOpenedInManager } from "../telemetry/vaultCounts";
import { useVaultProvider } from "./hooks";

export const opensItems = (provider: VaultProviderState | undefined) => provider?.capabilities.opensItems === true;

export const useOpensItems = (provider: string) => opensItems(useVaultProvider(provider));

export async function openInManager(provider: string, id: string, name: string): Promise<string | null> {
  const consent = consentToken();
  const result = await openVaultItem(provider, id).catch(() => null);
  noteOpenedInManager(!!result?.opened, consent);
  if (result?.opened) return null;
  return result?.error === "locked" ? `Unlock ${name} to open it there.` : `Couldn't open it in ${name}. Open ${name} and find it there.`;
}
