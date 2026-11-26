import { call, type ApplePasswordsPairing, type ApplePasswordsState } from "@ardia/ardiacore";

export type { ApplePasswordsPairing, ApplePasswordsState };

export const applePasswordsStatus = async (): Promise<ApplePasswordsState> => (await call("passwords.applePasswordsStatus", {})).state;
export const pairApplePasswords = async (): Promise<ApplePasswordsPairing> => (await call("passwords.applePasswordsPair", {})).outcome;
export const finishApplePasswordsPairing = async (code: string): Promise<ApplePasswordsPairing> => (await call("passwords.applePasswordsPairCode", { code })).outcome;
export const cancelApplePasswordsPairing = () => call("passwords.applePasswordsCancelPairing", {});
