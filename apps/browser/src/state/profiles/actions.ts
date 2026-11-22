import { storeAction } from "../browser/store";
import { currentProfile } from "../browser/current";

export const updateProfile = storeAction("updateProfile");
export const setDefaultProfile = storeAction("setDefaultProfile");
export const reorderProfiles = storeAction("reorderProfiles");
export const createProfile = storeAction("createProfile");

export const chooseIcon = (profileId: string, icon: string | null) => updateProfile(profileId, { icon, switcherDot: undefined });

export const setShareTopApps = (profileId: string, share: boolean) => updateProfile(profileId, { shareTopApps: share ? true : undefined });

export function commitProfileName(profileId: string, text: string): boolean {
  const name = text.trim();
  const profile = currentProfile(profileId);
  if (!profile || !name) return false;
  if (name !== profile.name) updateProfile(profileId, { name });
  return true;
}
