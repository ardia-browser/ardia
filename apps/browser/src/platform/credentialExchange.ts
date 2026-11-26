import { ardiaError } from "@ardia/core";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export type CredentialSourceKind = "apple" | "onePassword" | "bitwarden" | "other";
export type ExchangedLogin = { url: string; username: string; password: string };
export type ExchangedCode = { url: string; username: string; otpAuth: string };
export type ExchangedCredentials = {
  exporter: string;
  source: CredentialSourceKind;
  logins: ExchangedLogin[];
  codes: ExchangedCode[];
  passkeys: number;
  noSite: number;
  unsupported: number;
  receiveMs: number;
  parseMs: number;
};
export type CredentialExchangeStatus = { supported: boolean; receivable: boolean; fixture: boolean; pending: number };
export type CredentialExchangeRequest = "fixture" | "opened" | "logged" | "failed";
export type PasswordBatchResult = { saved: number; existing: number; failed: number };

type Native = {
  status(): CredentialExchangeStatus;
  request(): Promise<CredentialExchangeRequest>;
  take(): Promise<string | null>;
  addListener(name: "onCredentialExchange", listener: (e: { pending: number }) => void): EventSubscription;
};

type PasswordsBatch = { saveMany?(profile: string, logins: string): Promise<string> };

const native = requireOptionalNativeModule<Native>("ArdiaCredentialExchange");
const unsupported: CredentialExchangeStatus = { supported: false, receivable: false, fixture: false, pending: 0 };

export const credentialExchangeStatus = (): CredentialExchangeStatus => native?.status() ?? unsupported;

export const requestCredentialExchange = async (): Promise<CredentialExchangeRequest> => (native ? native.request() : "failed");

export async function takeExchangedCredentials(): Promise<ExchangedCredentials | null> {
  if (!native) return null;
  try {
    const json = await native.take();
    return json ? (JSON.parse(json) as ExchangedCredentials) : null;
  } catch (error) {
    throw ardiaError(error);
  }
}

export const onCredentialExchange = (listener: () => void): EventSubscription | null => native?.addListener("onCredentialExchange", listener) ?? null;

export function passwordBatchSaver(): ((profile: string, logins: { origin: string; username: string; password: string }[]) => Promise<PasswordBatchResult>) | null {
  const passwords = requireOptionalNativeModule<PasswordsBatch>("ArdiaPasswords");
  const saveMany = passwords?.saveMany;
  if (typeof saveMany !== "function") return null;
  return async (profile, logins) => {
    const reply = JSON.parse(await saveMany.call(passwords, profile, JSON.stringify(logins))) as { added?: number; existing?: number; invalid?: number };
    const saved = reply.added ?? 0;
    const existing = reply.existing ?? 0;
    return { saved, existing, failed: Math.max(logins.length - saved - existing, reply.invalid ?? 0) };
  };
}
