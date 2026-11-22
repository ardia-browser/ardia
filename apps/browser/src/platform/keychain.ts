import { nativeModule, type KeychainReadResult } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export type { KeychainReadResult };

const Keychain = nativeModule(t(`ArdiaKeychain`));

export const keychainGet = (account: string) => Keychain.get(account);
export const keychainRead = (account: string): Promise<KeychainReadResult> => Keychain.read(account);
export const keychainSet = (account: string, secret: string) => Keychain.set(account, secret);
export const keychainDelete = (account: string) => Keychain.delete(account);
