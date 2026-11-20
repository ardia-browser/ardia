import { consentToken, type ConsentToken } from "../telemetry/choice";
import { getPasswordAutofill } from "../../platform/passwords";
import { useBrowser } from "../browser/store";
import { ARDIA_PROVIDER, passwordManagersOnly, passwordProfileOfTab } from "./ardia";
import { claimChromeDropdowns, forgetChromeDropdownClaims, type ChromeDropdownKind } from "./chromeDropdown";
import { onArdiaProfilesChanged, vaultsOnForTab } from "./enabled";
import { isConnected, useVaults } from "./store";

const POLICY = "policy";
const ARDIA_OFF: readonly ChromeDropdownKind[] = ["login"];
const NOTHING: readonly ChromeDropdownKind[] = [];

const offered = new Map<string, boolean>();
const asking = new Set<string>();
const claimedTabs = new Set<string>();

export function chromeDropdownPolicy(onArdia: boolean, ardiaOffered: boolean | undefined, managersConnected: boolean): readonly ChromeDropdownKind[] {
  return onArdia && ardiaOffered === false && managersConnected ? ARDIA_OFF : NOTHING;
}

const managersConnected = (providers = useVaults.getState().providers) => passwordManagersOnly(providers).some(isConnected);

function askOffered(profile: string, consent: ConsentToken | null) {
  if (offered.has(profile) || asking.has(profile)) return;
  asking.add(profile);
  void getPasswordAutofill(profile)
    .then((on) => noteArdiaOffered(profile, on !== false, consent))
    .catch(() => undefined)
    .finally(() => asking.delete(profile));
}

function claimTab(tabId: string, consent: ConsentToken | null) {
  const profile = passwordProfileOfTab(tabId);
  if (profile !== null) askOffered(profile, consent);
  const kinds = chromeDropdownPolicy(vaultsOnForTab(tabId), profile === null ? undefined : offered.get(profile), managersConnected());
  if (kinds.length) claimedTabs.add(tabId);
  else if (!claimedTabs.delete(tabId)) return;
  void claimChromeDropdowns(tabId, POLICY, kinds, null, consent);
}

const claimAllTabs = (consent: ConsentToken | null) => {
  for (const tabId of Object.keys(useBrowser.getState().tabs)) claimTab(tabId, consent);
};

export function noteArdiaOffered(profile: string, on: boolean, consent: ConsentToken | null) {
  if (offered.get(profile) === on) return;
  offered.set(profile, on);
  claimAllTabs(consent);
}

export function startChromeDropdownPolicy() {
  claimAllTabs(consentToken());
  const stopBrowser = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    const consent = consentToken();
    for (const tabId of Object.keys(s.tabs)) if (s.tabs[tabId]?.profileId !== prev.tabs[tabId]?.profileId || !prev.tabs[tabId]) claimTab(tabId, consent);
    for (const tabId of Object.keys(prev.tabs)) {
      if (s.tabs[tabId]) continue;
      if (claimedTabs.delete(tabId)) void claimChromeDropdowns(tabId, POLICY, [], null, consent);
      forgetChromeDropdownClaims(tabId);
    }
  });
  const stopVaults = useVaults.subscribe((s, prev) => {
    const ardia = (v: typeof s) => v.providers.find((p) => p.id === ARDIA_PROVIDER)?.state;
    if (ardia(s) !== ardia(prev)) {
      offered.clear();
      return claimAllTabs(consentToken());
    }
    if (managersConnected(s.providers) !== managersConnected(prev.providers)) claimAllTabs(consentToken());
  });
  const stopScope = onArdiaProfilesChanged(claimAllTabs);
  return () => {
    stopBrowser();
    stopVaults();
    stopScope();
  };
}
