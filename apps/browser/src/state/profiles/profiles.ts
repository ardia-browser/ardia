import type { StateCreator } from "zustand";
import type { BrowserState } from "../browser/store";
import { engineBookmarkRoots, ensureRoots, removeBookmarkTree } from "../bookmarks/bookmarks";
import type { Profile, TopApp, Tab } from "../browser/types";
import { newId, without } from "../browser/model";

export const DEFAULT_PROFILE: Profile = { id: "default", name: "Personal", icon: null, engineId: "", createdAt: 0 };

export type ProfilesSlice = {
  profiles: Record<string, Profile>;
  orphanedProfileData: string[];
  profileDataDeleted(engineId: string): void;
  topApps: Record<string, TopApp[]>;
  parkedTopApps: Record<string, Tab[]>;
  createProfile(options: { name: string; icon?: string | null }): string;
  updateProfile(id: string, patch: Partial<Pick<Profile, "name" | "icon" | "passwordManager">>): void;
  deleteProfile(id: string, replacementId?: string): void;
};

export const sortedProfiles = (profiles: Record<string, Profile>): Profile[] =>
  Object.values(profiles).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

export const createProfilesSlice: StateCreator<BrowserState, [], [], ProfilesSlice> = (set, get) => ({
  profiles: { [DEFAULT_PROFILE.id]: DEFAULT_PROFILE },
  topApps: {},
  parkedTopApps: {},
  orphanedProfileData: [],
  profileDataDeleted(engineId) {
    set((s) => ({ orphanedProfileData: s.orphanedProfileData.filter((id) => id !== engineId) }));
  },
  createProfile({ name, icon = null }) {
    const id = newId("profile");
    set((s) => ({
      profiles: { ...s.profiles, [id]: { id, name: name.trim() || "New Profile", icon, engineId: id, createdAt: Date.now() } },
      bookmarks: ensureRoots(s.bookmarks, id)[0],
    }));
    return id;
  },
  updateProfile(id, patch) {
    set((s) => s.profiles[id] ? { profiles: { ...s.profiles, [id]: { ...s.profiles[id]!, ...patch } } } : {});
  },
  deleteProfile(id, replacementId) {
    let s = get();
    const profile = s.profiles[id];
    if (!profile || Object.keys(s.profiles).length <= 1 || Object.values(s.windows).some((window) => (window.kind === "private") && window.incognitoEngineId === profile.engineId)) return;
    const spaces = Object.values(s.spaces).filter((space) => space.profileId === id);
    if (spaces.length && (!replacementId || replacementId === id || !s.profiles[replacementId])) return;
    for (const space of spaces) get().assignSpaceProfile(space.id, replacementId!);
    s = get();
    const profiles = without(s.profiles, [id]);
    const engineLeft = !Object.values(profiles).some(({ engineId }) => engineId === profile.engineId);
    const roots = engineLeft ? engineBookmarkRoots(s.bookmarks, profile.engineId) : null;
    set({
      profiles,
      history: engineLeft ? without(s.history, [profile.engineId]) : s.history,
      bookmarks: roots ? removeBookmarkTree(s.bookmarks, [roots.bar, roots.other]) : s.bookmarks,
      bookmarksReady: engineLeft ? without(s.bookmarksReady, [profile.engineId]) : s.bookmarksReady,
      topApps: without(s.topApps, [id]),
      parkedTopApps: without(s.parkedTopApps, [id]),
      orphanedProfileData: engineLeft ? [...new Set([...s.orphanedProfileData, profile.engineId])] : s.orphanedProfileData,
    });
  },
});
