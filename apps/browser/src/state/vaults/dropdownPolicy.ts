import { consentToken, type ConsentToken } from "../telemetry/choice";
import { useBrowser } from "../browser/store";
import { claimChromeDropdowns, forgetChromeDropdownClaims, type ChromeDropdownKind } from "./chromeDropdown";
import { onArdiaProfilesChanged, vaultsOnForTab } from "./enabled";

const POLICY = "policy";
const ARDIA_OWNS: readonly ChromeDropdownKind[] = ["login", "passkey"];
const NOTHING: readonly ChromeDropdownKind[] = [];

const claimedTabs = new Set<string>();

export const chromeDropdownPolicy = (onArdia: boolean): readonly ChromeDropdownKind[] => (onArdia ? ARDIA_OWNS : NOTHING);

function claimTab(tabId: string, consent: ConsentToken | null) {
  const kinds = chromeDropdownPolicy(vaultsOnForTab(tabId));
  if (kinds.length) claimedTabs.add(tabId);
  else if (!claimedTabs.delete(tabId)) return;
  void claimChromeDropdowns(tabId, POLICY, kinds, null, consent);
}

const claimAllTabs = (consent: ConsentToken | null) => {
  for (const tabId of Object.keys(useBrowser.getState().tabs)) claimTab(tabId, consent);
};

export function noteArdiaOffered(_profile: string, _on: boolean, consent: ConsentToken | null) {
  claimAllTabs(consent);
}

export function startChromeDropdownPolicy() {
  claimAllTabs(consentToken());
  const stopBrowser = useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs === prev.tabs) return;
    const consent = consentToken();
    for (const tabId of Object.keys(s.tabs)) if (s.tabs[tabId]?.profileId !== prev.tabs[tabId]?.profileId || !prev.tabs[tabId]) claimTab(tabId, consent);
    for (const tabId of Object.keys(prev.tabs)) {
      if (s.tabs[tabId]) continue;
      if (claimedTabs.delete(tabId)) void claimChromeDropdowns(tabId, POLICY, [], null, consent);
      forgetChromeDropdownClaims(tabId);
    }
  });
  const stopScope = onArdiaProfilesChanged(claimAllTabs);
  return () => {
    stopBrowser();
    stopScope();
  };
}
