import type { VaultProviderState } from "../../platform/vaults";
import { preferredSaveTarget } from "./saveOffer";

export const PASSKEY_HOLDERS: ReadonlySet<string> = new Set(["ardia", "bitwarden"]);

const ARDIA = "ardia";

export type PasskeyTarget = { targets: string[]; target: string; note: string | null };

export function passkeyTarget(providers: readonly VaultProviderState[], chosen: string, nameOf: (id: string) => string): PasskeyTarget {
  const targets = [ARDIA, ...providers.filter((p) => p.id !== ARDIA && PASSKEY_HOLDERS.has(p.id) && p.state === "unlocked").map((p) => p.id)];
  const wanted = preferredSaveTarget(providers, chosen);
  if (!wanted || targets.includes(wanted)) return { targets, target: wanted || ARDIA, note: null };
  const name = nameOf(wanted);
  const note = PASSKEY_HOLDERS.has(wanted) ? `${name} is locked, so this passkey saves to Ardia. Unlock ${name} to save it there.` : `${name} can't keep passkeys saved from Ardia, so this one saves to Ardia.`;
  return { targets, target: ARDIA, note };
}
