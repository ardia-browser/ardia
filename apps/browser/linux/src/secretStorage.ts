import { safeStorage } from "electron";

const KEYRINGS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
const BASIC_PREFIX = "v10";

export type SecretProtection = { backend: string; keyring: boolean };

export function storageBackend(): string {
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return "unknown";
  }
}

export const isKeyring = (backend: string): boolean => KEYRINGS.has(backend);

export function ensureEncryption(): boolean {
  if (safeStorage.isEncryptionAvailable()) return true;
  if (process.platform === "linux" && !isKeyring(storageBackend())) safeStorage.setUsePlainTextEncryption(true);
  return safeStorage.isEncryptionAvailable();
}

export const secretProtection = (): SecretProtection => {
  const backend = storageBackend();
  return { backend, keyring: isKeyring(backend) };
};

export const sealedWithoutKeyring = (blob: Uint8Array): boolean => Buffer.from(blob.subarray(0, 3)).toString("latin1") === BASIC_PREFIX;

export const keyringAvailable = (): boolean => isKeyring(storageBackend()) && safeStorage.isEncryptionAvailable();
