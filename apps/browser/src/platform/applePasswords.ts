import { call, type ApplePasswordsState } from "@ardia/ardiacore";

export type { ApplePasswordsState };

export const applePasswordsStatus = async (): Promise<ApplePasswordsState> => (await call("passwords.applePasswordsStatus", {})).state;
