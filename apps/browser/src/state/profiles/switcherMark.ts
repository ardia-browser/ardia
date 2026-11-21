import { isFields } from "../../lib/decode";
import type { Profile } from "../browser/types";

export const switcherIconOf = (profile: Pick<Profile, "icon" | "switcherDot"> | undefined): string | null => (profile && !profile.switcherDot ? profile.icon : null);

export function patchedProfile(profile: Profile, patch: Partial<Profile>): Profile {
  const iconChanged = patch.icon !== undefined && patch.icon !== profile.icon;
  const { switcherDot, ...next } = { ...profile, ...patch };
  return switcherDot && !iconChanged ? { ...next, switcherDot } : next;
}

export const LEGACY_SWITCHER_ICONS_KEY = "profileSwitcherIcons";

export function profilesKeepingLegacyDots<P extends Pick<Profile, "icon" | "switcherDot">>(profiles: Record<string, P>, savedSettings: unknown): Record<string, P> {
  if (!isFields(savedSettings) || !(LEGACY_SWITCHER_ICONS_KEY in savedSettings) || savedSettings[LEGACY_SWITCHER_ICONS_KEY] === true) return profiles;
  return Object.fromEntries(Object.entries(profiles).map(([id, p]) => [id, p.icon ? { ...p, switcherDot: true as const } : p]));
}
