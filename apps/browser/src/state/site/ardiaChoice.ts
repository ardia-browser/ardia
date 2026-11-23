import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { consentToken } from "../telemetry/choice";
import { useBrowser } from "../browser/store";
import { usePlugins } from "../plugins/store";
import { setConsentPreflight, type ConsentOwner } from "../plugins/consentSurface";
import { confirmLeavingArdia } from "../vaults/settingsGuard";
import { vaultsOnForProfile } from "../vaults/enabled";
import { choosePasswordManager, currentPasswordManager } from "./passwordManager";
import { neverChosenProfiles, profilesSharingData, regularProfileId, storedPasswordManager, type PasswordManagerChoice } from "./passwordManagerChoice";

const browser = () => useBrowser.getState();
const pluginsView = () => usePlugins.getState();

const leavesArdia = (profileId: string, manager: PasswordManagerChoice) =>
  PLATFORM_FEATURES.systemPasswordManagers && manager !== "ardia" && currentPasswordManager(profileId) === "ardia";

export async function choosePasswordManagerChecked(profileId: string, manager: PasswordManagerChoice): Promise<boolean> {
  const consent = consentToken();
  if (leavesArdia(profileId, manager) && !(await confirmLeavingArdia())) return false;
  if (!browser().profiles[regularProfileId(profileId)]) return false;
  choosePasswordManager(profileId, manager, consent);
  return true;
}

export function recordArdiaChoice(profileId: string): boolean {
  const s = browser();
  if (!pluginsView().scanned || !s.profiles[regularProfileId(profileId)] || storedPasswordManager(s, profileId) !== undefined || !vaultsOnForProfile(profileId)) return false;
  for (const id of profilesSharingData(s, profileId)) s.updateProfile(id, { passwordManager: "ardia" });
  return true;
}

function keepNeverChosenOnArdia(name: string, owner: ConsentOwner): Promise<void> | null {
  const listing = pluginsView().listings[name];
  if (owner === "onboarding" || !listing?.official || !listing.manifest?.passwordManager) return null;
  const staying = neverChosenProfiles(browser()).filter((id) => currentPasswordManager(id) === "ardia");
  if (!staying.length) return null;
  return confirmLeavingArdia().then((confirmed) => {
    if (confirmed) return;
    const s = browser();
    for (const id of staying) if (s.profiles[id] && storedPasswordManager(s, id) === undefined) for (const member of profilesSharingData(s, id)) s.updateProfile(member, { passwordManager: "ardia" });
  });
}

export function startArdiaChoice() {
  if (PLATFORM_FEATURES.systemPasswordManagers && PLATFORM_FEATURES.plugins) setConsentPreflight(keepNeverChosenOnArdia);
}
