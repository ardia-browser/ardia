import { call, savePassword as saveNativePassword, updatePassword as updateNativePassword, type PasswordExportStatus, type SavedPassword } from "@ardia/ardiacore";
import { asSecret, reveal, type Secret } from "@ardia/core";

export type { SavedPassword, PasswordExportStatus };

export type PasswordSecret = Secret<"password">;

export const savePassword = (profile: string, origin: string, username: string, password: PasswordSecret) => saveNativePassword(profile, origin, username, reveal(password));
export const updatePassword = (profile: string, origin: string, username: string, changes: { username?: string; password?: PasswordSecret }) =>
  updateNativePassword(profile, origin, username, { username: changes.username, password: changes.password && reveal(changes.password) });

export const listPasswords = async (profile: string) => (await call("passwords.list", { profile })).passwords;
export const unlockPasswords = async (profile: string) => (await call("passwords.unlock", { profile })).unlocked;
export async function getPassword(profile: string, origin: string, username: string): Promise<PasswordSecret | null> {
  const { password } = await call("passwords.reveal", { profile, origin, username });
  return typeof password === "string" ? asSecret("password", password) : null;
}
export const deletePassword = async (profile: string, origin: string, username: string) =>
  !!(await call("passwords.remove", { profile, origin, username }));
export const setNeverSavePasswords = async (profile: string, origin: string, never: boolean) => {
  if (!never) await call("passwords.allowSaving", { profile, origin });
};
export const getNeverSavePasswordOrigins = async (profile: string) => (await call("passwords.neverSaveOrigins", { profile })).origins;
export const exportPasswords = (profile: string) => call("passwords.export", { profile });
export const getPasswordAutofill = (profile = "") => call("passwords.autofillEnabled", { profile });
export const setPasswordAutofill = (enabled: boolean, profile = "") => call("passwords.setAutofillEnabled", { profile, enabled });
