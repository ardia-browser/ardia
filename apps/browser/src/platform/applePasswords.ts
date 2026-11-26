import { call, on, type ApplePasswordsPairing, type ApplePasswordsState, type LoginListCount } from "@ardia/ardiacore";

export type { ApplePasswordsPairing, ApplePasswordsState, LoginListCount };

export const applePasswordsStatus = async (): Promise<ApplePasswordsState> => (await call("passwords.applePasswordsStatus", {})).state;
export const pairApplePasswords = async (): Promise<ApplePasswordsPairing> => (await call("passwords.applePasswordsPair", {})).outcome;
export const finishApplePasswordsPairing = async (code: string): Promise<ApplePasswordsPairing> => (await call("passwords.applePasswordsPairCode", { code })).outcome;
export const cancelApplePasswordsPairing = () => call("passwords.applePasswordsCancelPairing", {});
export const onApplePasswordsChanged = (listener: (state: ApplePasswordsState) => void) => on("passwords.applePasswordsChanged", ({ state }) => listener(state));
export const setApplePasswordsProfiles = (profiles: string[]) => call("passwords.setApplePasswordsProfiles", { profiles });
export const onLoginListCounted = (listener: (e: { name: LoginListCount; epoch?: string }) => void) => on("passwords.loginListCounted", listener);
