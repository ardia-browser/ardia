import { setArdiaProfiles } from "../../platform/vaults";
import { lockPasswords } from "../site/savedPasswords";
import { lockAllProviders } from "./actions";
import { ARDIA_PROVIDER } from "./ardia";
import { anyProfileOnArdia, ardiaEngineProfiles, onArdiaProfilesChanged, vaultsOnForTab } from "./enabled";
import { closeVaultMenu, useVaultMenus } from "./menu";
import { dismissVaultOffer, useVaultSaveOffers } from "./saveOffer";
import { applyProviderState, loadVaultItems } from "./store";

let sent: string | null = null;

function sendArdiaProfiles() {
  const profiles = ardiaEngineProfiles();
  const key = JSON.stringify(profiles);
  if (key === sent) return;
  sent = key;
  void setArdiaProfiles(profiles).then(
    (state) => {
      if (state) applyProviderState(state);
      return loadVaultItems(ARDIA_PROVIDER, true);
    },
    () => {
      if (sent === key) sent = null;
    },
  );
}

function closeSurfacesOffArdia() {
  for (const tabId of Object.keys(useVaultMenus.getState().menus)) if (!vaultsOnForTab(tabId)) closeVaultMenu(tabId);
  for (const tabId of Object.keys(useVaultSaveOffers.getState())) if (!vaultsOnForTab(tabId)) dismissVaultOffer(tabId);
}

export function turnEverythingOff() {
  closeSurfacesOffArdia();
  lockPasswords();
  return lockAllProviders();
}

export function startArdiaScope() {
  let wasOn = anyProfileOnArdia();
  sendArdiaProfiles();
  return onArdiaProfilesChanged(() => {
    sendArdiaProfiles();
    const on = anyProfileOnArdia();
    if (wasOn && !on) void turnEverythingOff().catch(() => undefined);
    else closeSurfacesOffArdia();
    wasOn = on;
  });
}
