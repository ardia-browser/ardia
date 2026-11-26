import { create } from "zustand";
import { setVaultAlways, vaultAlwaysGrants, vaultState, type VaultAlwaysGrant } from "../../platform/vault";
import { noteVaultTiming } from "../telemetry/vaultCounts";
import type { ConsentToken } from "../telemetry/client";
import { orWarn } from "../../lib/fallback";
import { mayAlwaysAllow, programKey, type Program } from "./programs";

export const useVaultAlways = create<{ grants: VaultAlwaysGrant[]; loaded: boolean }>()(() => ({ grants: [], loaded: false }));

let index = new Set<string>();
let loading: Promise<void> | null = null;

const keyOf = (profile: string, origin: string, teamId: string, identifier: string) => `${profile}\n${origin}\n${teamId}\n${identifier}`;

function publish(grants: VaultAlwaysGrant[]) {
  index = new Set(grants.map((g) => keyOf(g.profile, g.origin, g.teamId, g.identifier)));
  useVaultAlways.setState({ grants, loaded: true });
}

export function loadVaultAlways(consent: ConsentToken | null): Promise<void> {
  loading ??= vaultAlwaysGrants()
    .then(publish, (error: unknown) => {
      orWarn(undefined)(error);
      useVaultAlways.setState({ loaded: true });
    })
    .then(() => vaultState())
    .then((state) => noteVaultTiming("unlock", state.unlockMs, consent), orWarn(undefined));
  return loading;
}

export const alwaysAllowed = (profile: string, origin: string, program: Program) =>
  mayAlwaysAllow(program) && index.has(keyOf(profile, origin, program.teamId!, program.identifier!));

export async function setAlwaysAllowed(profile: string, origins: readonly string[], program: Program, on: boolean): Promise<boolean> {
  if (on && !mayAlwaysAllow(program)) return false;
  const [teamId, identifier] = programKey(program).split("\n") as [string, string];
  let ok = true;
  for (const origin of origins) ok = (await setVaultAlways(profile, origin, teamId, identifier, program.name, on).catch(orWarn(false))) && ok;
  publish(await vaultAlwaysGrants().catch(orWarn(useVaultAlways.getState().grants)));
  return ok;
}

export async function removeAlwaysGrant(grant: VaultAlwaysGrant): Promise<boolean> {
  const ok = await setVaultAlways(grant.profile, grant.origin, grant.teamId, grant.identifier, grant.program, false).catch(orWarn(false));
  publish(await vaultAlwaysGrants().catch(orWarn(useVaultAlways.getState().grants)));
  return ok;
}
