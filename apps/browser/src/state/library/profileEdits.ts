import type { View } from "react-native";
import { chooseFromMenu } from "../app/menuChoice";
import { deleteProfile } from "../browser/actions";
import { currentProfile, currentProfileOrder } from "../browser/current";
import type { ProfileColor } from "../browser/types";
import { openSettings } from "../settings/settingsWindows";
import { commitProfileName, reorderProfiles, setShareTopApps } from "../profiles/actions";
import { requestCreateProfile } from "../profiles/createProfileRequest";
import { openProfileIconPicker } from "../profiles/iconPicker";
import { profileColorItems, profileMenuItems, profileMenuStateOf, type ProfileColorChoice } from "../profiles/profileMenu";
import { choosePresetColor } from "../profiles/themeActions";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { noteLibraryProfileEdit } from "../telemetry/libraryCounts";

export function renameLibraryProfile(profileId: string, text: string): boolean {
  const before = currentProfile(profileId)?.name;
  const committed = commitProfileName(profileId, text);
  if (committed && currentProfile(profileId)?.name !== before) noteLibraryProfileEdit("rename");
  return committed;
}

export function colorLibraryProfile(profileId: string, color: ProfileColor, consent?: ConsentToken | null) {
  const profile = currentProfile(profileId);
  if (!profile || (profile.color === color && !profile.theme)) return;
  choosePresetColor(profileId, color);
  noteLibraryProfileEdit("color", consent);
}

export function movedProfileOrder(order: readonly string[], profileId: string, to: number): string[] | null {
  const from = order.indexOf(profileId);
  const target = Math.max(0, Math.min(order.length - 1, to));
  if (from < 0 || from === target) return null;
  const next = order.filter((id) => id !== profileId);
  next.splice(target, 0, profileId);
  return next;
}

export function moveLibraryProfile(profileId: string, to: number, consent?: ConsentToken | null) {
  const next = movedProfileOrder(currentProfileOrder(), profileId, to);
  if (!next) return;
  reorderProfiles(next);
  noteLibraryProfileEdit("reorder", consent);
}

export function nudgeLibraryProfile(profileId: string, step: -1 | 1, consent?: ConsentToken | null) {
  const at = currentProfileOrder().indexOf(profileId);
  if (at >= 0) moveLibraryProfile(profileId, at + step, consent);
}

export async function addLibraryProfile(windowId: string, consent?: ConsentToken | null): Promise<string | null> {
  const token = consent === undefined ? consentToken() : consent;
  const id = await requestCreateProfile(windowId);
  if (id) noteLibraryProfileEdit("add", token);
  return id;
}

export async function deleteLibraryProfile(profileId: string, windowId: string, consent?: ConsentToken | null) {
  const token = consent === undefined ? consentToken() : consent;
  if (!currentProfile(profileId)) return;
  await deleteProfile(profileId, windowId);
  if (!currentProfile(profileId)) noteLibraryProfileEdit("delete", token);
}

export const changeLibraryProfileIcon = (profileId: string, windowId: string, anchor: View | null) => openProfileIconPicker(profileId, windowId, "library", anchor);

export async function chooseLibraryProfileColor(profileId: string, colors: ProfileColorChoice[]) {
  const consent = consentToken();
  const profile = currentProfile(profileId);
  if (!profile) return;
  const choice = await chooseFromMenu(profileColorItems(colors, profile.theme ? null : profile.color));
  if (choice) colorLibraryProfile(profileId, choice.color, consent);
}

export async function showLibraryProfileMenu(
  profileId: string,
  { windowId, anchor, colors, rename }: { windowId: string; anchor: View | null; colors: ProfileColorChoice[]; rename: () => void },
) {
  const consent = consentToken();
  const state = profileMenuStateOf(profileId, "library", colors);
  if (!state) return;
  const choice = await chooseFromMenu(profileMenuItems(state));
  if (!choice || !currentProfile(profileId)) return;
  if (typeof choice === "object") return colorLibraryProfile(profileId, choice.color, consent);
  if (choice === "rename") return rename();
  if (choice === "icon") return void changeLibraryProfileIcon(profileId, windowId, anchor);
  if (choice === "topApps") return setShareTopApps(profileId, !currentProfile(profileId)?.shareTopApps);
  if (choice === "moveLeft") return nudgeLibraryProfile(profileId, -1, consent);
  if (choice === "moveRight") return nudgeLibraryProfile(profileId, 1, consent);
  if (choice === "newProfile") return void addLibraryProfile(windowId, consent);
  if (choice === "settings") return openSettings("profiles", profileId);
  if (choice === "delete") return void deleteLibraryProfile(profileId, windowId, consent);
}
