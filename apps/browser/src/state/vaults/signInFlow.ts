import type { VaultNeeds, VaultSignInRequest, VaultSignInResult } from "../../platform/vaults";
import { credential, type SignInField, type SignInMethod } from "./providerModel";

export const FAILED_SIGN_IN = "failed";
export const CANCELLED_SIGN_IN = "cancelled";
export const SERVER_REFUSED = "Enter the server as an https address.";

export const wasCancelled = (result: VaultSignInResult) => !result.ok && result.error === CANCELLED_SIGN_IN;

export function signInMessage(result: VaultSignInResult, name: string): string {
  if (result.ok || wasCancelled(result)) return "";
  const problem = result.state ? credential(result.state).problem?.message : undefined;
  if (result.error && result.error !== FAILED_SIGN_IN) return result.error;
  if (problem) return problem;
  return `${name} didn't respond. Try again.`;
}

export function needsOf(result: VaultSignInResult | null): VaultNeeds | null {
  if (!result || result.ok) return null;
  const stated = result.state ? credential(result.state).needs : undefined;
  if (stated) return stated;
  if (!result.needs) return null;
  return {
    kind: result.needs,
    ...(result.field ? { field: result.field } : {}),
    ...(result.methods ? { methods: result.methods.map((m) => ({ id: m.id, title: m.name, ...(m.sendsCode ? { sendsCode: true } : {}) })) } : {}),
    ...(result.accounts ? { accounts: result.accounts } : {}),
  };
}

export function errorAfter(result: VaultSignInResult, name: string, asked: VaultNeeds | null): string {
  if (result.ok || wasCancelled(result)) return "";
  const next = needsOf(result);
  if (next && !asked && !result.error) return "";
  if (next && asked && next.kind !== asked.kind && !result.error) return "";
  if (next?.kind === "approval") return "";
  const message = signInMessage(result, name);
  return next?.message && next.message === message ? "" : message;
}

export type Entries = { values: Record<string, string>; secretLengths: Record<string, number> };

export const isFilled = (field: SignInField, entries: Entries) =>
  field.type === "secret" ? (entries.secretLengths[field.id] ?? 0) > 0 : (entries.values[field.id] ?? "").trim().length > 0;

export const canSubmit = (method: SignInMethod, entries: Entries, serverReady: boolean) =>
  serverReady && method.fields.every((f) => f.optional || isFilled(f, entries));

export function requestFor(method: SignInMethod, entries: Entries, secretTokens: Record<string, string>, server: string | null | undefined): VaultSignInRequest {
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of method.fields) {
    if (!isFilled(field, entries)) continue;
    if (field.type === "secret") secrets[field.id] = secretTokens[field.id]!;
    else values[field.id] = entries.values[field.id]!.trim();
  }
  return { method: method.id, ...(server ? { server } : {}), values, secrets };
}

export function submitTitle(method: SignInMethod): string {
  return method.kind === "credentials" ? "Sign In" : "Continue";
}

export function waitingLine(method: SignInMethod, name: string): string {
  return method.kind === "desktopApproval" ? `Approve Ardia in ${method.appTitle || name}.` : "Approve in your browser.";
}

export function needLabel(needs: VaultNeeds, passwordTitle: string | null, fieldTitle: string | null): string {
  if (needs.kind === "field") return fieldTitle ?? "";
  if (needs.kind === "code") return "Code";
  if (needs.kind === "email") return "Email";
  if (needs.kind === "account") return "Account";
  if (needs.kind === "password") return passwordTitle ?? "Password";
  return "";
}

export function installCheckError(stillMissing: boolean, name: string): string {
  return stillMissing ? `${name}'s command-line tool still isn't installed.` : "";
}
