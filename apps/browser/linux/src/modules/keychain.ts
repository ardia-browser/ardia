import { safeStorage } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineModule } from "../bridge";
import { note } from "../log";
import { dataDirectory } from "../paths";
import { ensureEncryption, isKeyring, keyringAvailable, secretProtection, storageBackend, type SecretProtection } from "../secretStorage";
import { writeDocument } from "./documents";

const FILE = "Secrets.json";
type Stored = { backend: string; sealed: boolean; value: string };

let cache: Record<string, Stored> | null = null;

function load(): Record<string, Stored> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(join(dataDirectory(), FILE), "utf8")) as Record<string, Stored>;
  } catch {
    cache = {};
  }
  return cache;
}

const persist = () => writeDocument(FILE, JSON.stringify(load()));

export function sealSecret(secret: string): Stored {
  if (!ensureEncryption()) throw new Error("secrets can't be encrypted on this system");
  return { backend: storageBackend(), sealed: true, value: safeStorage.encryptString(secret).toString("base64") };
}

export function openSecret(stored: Stored): string | null {
  try {
    if (!stored.sealed) return Buffer.from(stored.value, "base64").toString("utf8");
    ensureEncryption();
    return safeStorage.decryptString(Buffer.from(stored.value, "base64"));
  } catch (error) {
    note("keychain", `a secret couldn't be opened (${stored.backend}): ${String(error)}`);
    return null;
  }
}

const needsSealing = (stored: Stored) => !stored.sealed || (!isKeyring(stored.backend) && keyringAvailable());

function resealed(account: string): void {
  const secrets = load();
  const stored = secrets[account];
  if (!stored || !needsSealing(stored)) return;
  const secret = openSecret(stored);
  if (secret === null) return;
  try {
    secrets[account] = sealSecret(secret);
    note("keychain", `a secret moved from ${stored.sealed ? stored.backend : "plain storage"} to ${secrets[account]!.backend}`);
    persist();
  } catch (error) {
    note("keychain", `a secret couldn't be sealed again: ${String(error)}`);
  }
}

export async function get(account: string): Promise<string | null> {
  resealed(account);
  const stored = load()[account];
  return stored ? openSecret(stored) : null;
}

export async function set(account: string, secret: string): Promise<boolean> {
  load()[account] = sealSecret(String(secret));
  persist();
  return true;
}

export async function remove(account: string): Promise<boolean> {
  const secrets = load();
  if (!(account in secrets)) return true;
  delete secrets[account];
  persist();
  return true;
}

export const protection = async (): Promise<SecretProtection> => secretProtection();

defineModule("ArdiaKeychain", {
  async: { get, set, delete: remove, backend: async () => storageBackend(), protection },
});
