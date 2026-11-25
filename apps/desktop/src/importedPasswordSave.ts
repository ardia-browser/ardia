import { reveal } from "@ardia/core";
import { savePassword as sharedSavePassword } from "../../browser/src/state/site/passwords.ts";
import { claimImportHandle, isImportHandle } from "./importHandles.ts";

export * from "../../browser/src/state/site/passwords.ts";

export const savePassword: typeof sharedSavePassword = (profile, origin, username, password) => {
  const text = reveal(password);
  return isImportHandle(text) ? claimImportHandle(text, profile) : sharedSavePassword(profile, origin, username, password);
};
