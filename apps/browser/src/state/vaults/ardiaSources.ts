import { useMemo } from "react";
import type { VaultProviderState } from "../../platform/vaults";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { cached, load, onResourceChanged, useResource } from "../settings/resources";
import { connectArdiaSource, passwordAutofill, refreshFieldProviders } from "../site/passwordManager";
import { regularProfileId } from "../site/passwordManagerChoice";
import { passwordManagersOnly } from "./ardia";
import { isConnected, useVaults } from "./store";
import { vaultsOnForProfile, vaultsOnForTab } from "./enabled";

export { vaultsSupported } from "./enabled";

const connectedManagers = (providers: readonly VaultProviderState[]) => passwordManagersOnly(providers).filter(isConnected);

const connectedKey = (providers: readonly VaultProviderState[]) =>
  connectedManagers(providers)
    .map((p) => p.id)
    .join("\n");

function savesAndFills(profile: string): boolean {
  const known = cached(passwordAutofill, [profile]);
  if (known === undefined) void load(passwordAutofill, [profile]).catch(() => undefined);
  return known === true;
}

export const ardiaHasSource = (profile: string) => connectedManagers(useVaults.getState().providers).length > 0 || savesAndFills(profile);

export function ardiaFillsInTab(tabId: string): boolean {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  return !!tab && vaultsOnForTab(tabId) && ardiaHasSource(engineProfile(s, regularProfileId(tab.profileId)));
}

let started = false;

export function startArdiaSources() {
  if (started) return;
  started = true;
  connectArdiaSource((profileId, profile) => vaultsOnForProfile(profileId) && ardiaHasSource(profile));
  useVaults.subscribe((s, prev) => {
    if (s.providers !== prev.providers && connectedKey(s.providers) !== connectedKey(prev.providers)) refreshFieldProviders();
  });
  onResourceChanged(passwordAutofill, refreshFieldProviders);
}

export type ArdiaSources = { saved: boolean; managers: string[] };

const isOn = (p: Pick<VaultProviderState, "state" | "unavailable">) => !(p.state === "unavailable" && p.unavailable?.reason === "off");

export const managersOn = (providers: readonly VaultProviderState[]) => passwordManagersOnly(providers).filter(isOn);

export function useManagersOn(): string[] {
  const names = useVaults((s) =>
    managersOn(s.providers)
      .map((p) => p.name)
      .join("\n"),
  );
  return useMemo(() => (names ? names.split("\n") : []), [names]);
}

export function useArdiaSources(profileId: string): ArdiaSources {
  const profile = useBrowser((s) => engineProfile(s, regularProfileId(profileId)));
  const [saved] = useResource(passwordAutofill, profile);
  const names = useVaults((s) =>
    connectedManagers(s.providers)
      .map((p) => p.name)
      .join("\n"),
  );
  return useMemo(() => ({ saved: saved === true, managers: names ? names.split("\n") : [] }), [saved, names]);
}
