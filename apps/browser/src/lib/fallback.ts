import { errorText } from "./errors";
import { t } from "./uiLanguage";


export type PasswordAction = t(`browser import`) | t(`csv import`) | t(`settings edit`) | t(`settings delete`) | t(`sync delete`);

export const orWarn =
  <T,>(fallback: T, action?: PasswordAction) =>
  (error: unknown): T => {
    console.warn(`[engine] ${action ? `${action}: ` : ""}${errorText(error)}`);
    return fallback;
  };

export type PasswordFailure = "refused-or-already-saved" | "not-landed-in-time" | "other";

export function passwordFailure(error: unknown): PasswordFailure {
  const text = errorText(error);
  if (text.includes(t(`Could not save the password`))) return "refused-or-already-saved";
  if (text.includes(t(`didn't take the change`))) return "not-landed-in-time";
  return "other";
}
