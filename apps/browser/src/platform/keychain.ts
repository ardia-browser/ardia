import { nativeModule, type KeychainReadResult } from "@ardia/shell";
import { asSecret, reveal, type Secret, type SecretKind } from "@ardia/core";

export type { KeychainReadResult };

type KeychainSecretRead<K extends SecretKind> = { status: "ok"; value: Secret<K> } | { status: "missing" } | { status: "error"; reason: string };

const Keychain = nativeModule("ArdiaKeychain");

export const keychainRead = (account: string): Promise<KeychainReadResult> => Keychain.read(account);
export const keychainSet = (account: string, secret: string) => Keychain.set(account, secret);
export const keychainDelete = (account: string) => Keychain.delete(account);

export async function keychainGetSecret<K extends SecretKind>(account: string, kind: K): Promise<Secret<K> | null> {
  const value = await Keychain.get(account);
  return typeof value === "string" && value ? asSecret(kind, value) : null;
}

export async function keychainReadSecret<K extends SecretKind>(account: string, kind: K): Promise<KeychainSecretRead<K>> {
  const read = await Keychain.read(account);
  return read.status === "ok" ? { status: "ok", value: asSecret(kind, read.value) } : read;
}

export const keychainSetSecret = (account: string, secret: Secret) => Keychain.set(account, reveal(secret));
