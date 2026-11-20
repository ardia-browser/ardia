import { resolveInput } from "@ardia/core";

export type ReturnAction = { kind: "row" } | { kind: "url"; url: string } | { kind: "pending" } | { kind: "none" };

export type SubmitState = { shown: boolean; enabled: boolean; returnCue: boolean };

const NO_ACTION: ReturnAction = { kind: "none" };

export function returnAction({ hasRow, text, typed, scope, providerSettled, searchUrl }: { hasRow: boolean; text: string; typed: string; scope: "provider" | "other" | null; providerSettled: boolean; searchUrl: string }): ReturnAction {
  if (hasRow) return { kind: "row" };
  if (scope === "provider") return typed.trim() && !providerSettled ? { kind: "pending" } : NO_ACTION;
  if (scope) return NO_ACTION;
  const url = resolveInput(text, searchUrl);
  return url ? { kind: "url", url } : NO_ACTION;
}

export function submitAction({ hero, action, rowShown }: { hero: boolean; action: ReturnAction; rowShown: boolean }): SubmitState {
  const enabled = action.kind !== "none";
  const rowCarriesReturn = action.kind === "row" && rowShown;
  if (hero) return { shown: true, enabled, returnCue: enabled && !rowCarriesReturn };
  const shown = enabled && !rowCarriesReturn;
  return { shown, enabled: shown, returnCue: shown };
}
