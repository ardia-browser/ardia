import type { VaultPasskeyDelegate, VaultProviderState } from "../../platform/vaults";
import { preferredSaveTarget } from "./saveOffer";

const ARDIA = "ardia";

export const holdsPasskeys = (provider: VaultProviderState | undefined) => !!provider && (provider.id === ARDIA || provider.capabilities?.passkeys === true);

export const delegatesPasskeys = (provider: VaultProviderState | undefined) => !!provider?.capabilities?.passkeysVia?.length;

export type PasskeyTarget = { targets: string[]; target: string; note: string | null };

export function passkeyTarget(providers: readonly VaultProviderState[], chosen: string, nameOf: (id: string) => string, delegates: readonly VaultPasskeyDelegate[] = []): PasskeyTarget {
  const holders = providers.filter((p) => p.id !== ARDIA && holdsPasskeys(p) && p.state === "unlocked").map((p) => p.id);
  const targets = [ARDIA, ...holders, ...delegates.map((d) => d.provider).filter((id) => id !== ARDIA && !holders.includes(id))];
  const wanted = preferredSaveTarget(providers, chosen);
  if (!wanted || targets.includes(wanted)) return { targets, target: wanted || ARDIA, note: null };
  const provider = providers.find((p) => p.id === wanted);
  if (delegatesPasskeys(provider)) return { targets, target: ARDIA, note: null };
  const name = nameOf(wanted);
  const note = holdsPasskeys(provider) ? `${name} is locked, so this passkey saves to Ardia. Unlock ${name} to save it there.` : `${name} can't keep passkeys saved from Ardia, so this one saves to Ardia.`;
  return { targets, target: ARDIA, note };
}

export type PasskeyRoute = "ardia" | "holder" | "system" | "extension";

export function routeOfTarget(target: string, providers: readonly VaultProviderState[], delegates: readonly VaultPasskeyDelegate[] = []): PasskeyRoute {
  if (target === ARDIA) return "ardia";
  const delegate = delegates.find((d) => d.provider === target);
  if (delegate) return delegate.via;
  return holdsPasskeys(providers.find((p) => p.id === target)) ? "holder" : "ardia";
}

export const systemRowId = (provider: string) => `delegate:${provider}`;
export const providerOfSystemRow = (id: string | null) => (id?.startsWith("delegate:") ? id.slice("delegate:".length) : null);
