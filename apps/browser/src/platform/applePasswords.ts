import { reveal, type Secret } from "@ardia/core";
import { call, on, type ApplePasswordsFailureKind, type ApplePasswordsPairing, type ApplePasswordsSaveCount, type ApplePasswordsState, type LoginListCount, type LoginListEngine } from "@ardia/ardiacore";

export type { ApplePasswordsFailureKind, ApplePasswordsPairing, ApplePasswordsSaveCount, ApplePasswordsState, LoginListCount, LoginListEngine };

export const applePasswordsStatus = async (): Promise<ApplePasswordsState> => (await call("passwords.applePasswordsStatus", {})).state;
export const pairApplePasswords = async (): Promise<ApplePasswordsPairing> => (await call("passwords.applePasswordsPair", {})).outcome;
export const finishApplePasswordsPairing = async (code: Secret<"pairingCode">): Promise<ApplePasswordsPairing> => (await call("passwords.applePasswordsPairCode", { code: reveal(code) })).outcome;
export const cancelApplePasswordsPairing = () => call("passwords.applePasswordsCancelPairing", {});
export const onApplePasswordsChanged = (listener: (state: ApplePasswordsState) => void) => on("passwords.applePasswordsChanged", ({ state }) => listener(state));
export const setApplePasswordsProfiles = (profiles: string[]) => call("passwords.setApplePasswordsProfiles", { profiles });
export const onLoginListCounted = (listener: (e: { name: LoginListCount; engine?: LoginListEngine; kind?: ApplePasswordsFailureKind; epoch?: string }) => void) => on("passwords.loginListCounted", listener);
export const onApplePasswordsSaveCounted = (listener: (e: { name: ApplePasswordsSaveCount; engine?: LoginListEngine; kind?: ApplePasswordsFailureKind; epoch?: string }) => void) => on("passwords.applePasswordsSaveCounted", listener);
