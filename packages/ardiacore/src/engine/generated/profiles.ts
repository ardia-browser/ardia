import type { BrowsingDataType } from "../../profiles";
import type { Profile } from "../wire";

export type ProfilesCalls = {
  "profiles.loaded": [{}, { profiles: string[] }];
  "profiles.ctrlTabMru": [{}, { profiles: Record<string, boolean> }];
  "profiles.release": [Profile, null];
  "profiles.unloadIdle": [Profile, { status: "released" | "pending" | "busy"; tabs: string[]; heldBy?: string }];
  "profiles.deleteData": [Profile, { remaining: string[] }];
  "profiles.clearBrowsingData": [Profile & { types: BrowsingDataType[]; since: number | null }, null];
};

export type ProfilesEvents = {
  "profiles.loaded": { profile: string };
};
