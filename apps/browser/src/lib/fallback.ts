import { isUnknownCall } from "@ardia/core";
import { errorText } from "./errors";

export type PasswordAction = "browser import" | "csv import" | "settings edit" | "settings delete" | "sync delete";

export const orWarn =
  <T,>(fallback: T, action?: PasswordAction) =>
  (error: unknown): T => {
    console.warn(`[engine] ${action ? `${action}: ` : ""}${errorText(error)}`);
    return fallback;
  };

export const tolerateMissingCall = (error: unknown): void => {
  if (!isUnknownCall(error)) throw error;
  console.warn(`[engine] ${error.message}`);
};

export type PasswordFailure = "refused-or-already-saved" | "not-landed-in-time" | "other";

export function passwordFailure(error: unknown): PasswordFailure {
  const text = errorText(error);
  if (text.includes("Could not save the password")) return "refused-or-already-saved";
  if (text.includes("didn't take the change")) return "not-landed-in-time";
  return "other";
}
