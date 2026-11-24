import { call, on, type BrowsingDataType } from "@ardia/ardiacore";

export type { BrowsingDataType };
export type { WindowProfileSwapped } from "@ardia/shell";

export const clearBrowsingData = (profile: string, types: BrowsingDataType[], since?: number) =>
  call("profiles.clearBrowsingData", { profile, types, since: since ?? null }).then(() => {});
export const releaseProfile = (profile: string) => call("profiles.release", { profile });
export const unloadIdleProfile = (profile: string) => call("profiles.unloadIdle", { profile });
export const deleteProfileData = async (profile: string): Promise<string[]> => (await call("profiles.deleteData", { profile })).remaining;
export const chromeCtrlTabMru = async (): Promise<Record<string, boolean> | null> => (await call("profiles.ctrlTabMru"))?.profiles ?? null;
export const loadedProfiles = async (): Promise<string[]> => (await call("profiles.loaded")).profiles;
export const onProfileLoaded = (listener: (profile: string) => void) => on("profiles.loaded", ({ profile }) => listener(profile));
