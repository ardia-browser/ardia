import type { EventSubscription } from "expo-modules-core";

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

export const credentialExchangeStatus = (): CredentialExchangeStatus => ({ supported: false, receivable: false, fixture: false, pending: 0 });
export const requestCredentialExchange = async (): Promise<CredentialExchangeRequest> => "failed";
export const takeExchangedCredentials = async (): Promise<ExchangedCredentials | null> => null;
export const onCredentialExchange = (_listener: () => void): EventSubscription | null => null;
export const passwordBatchSaver = (): ((profile: string, logins: { origin: string; username: string; password: string }[]) => Promise<PasswordBatchResult>) | null => null;
