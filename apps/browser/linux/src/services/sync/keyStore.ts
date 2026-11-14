import { safeStorage } from "electron";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { note } from "../../log";
import { dataDirectory } from "../../paths";
import { KEY_BYTES } from "./crypto.ts";
import { saveFile } from "./vault.ts";

type StoredKey = { version: 1; backend: string; sealed: string };

const ACCOUNT = /^[a-z2-7]{1,64}$/;
const KEYRINGS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);

const keptUntilQuit = new Map<string, Buffer>();

function keyPath(account: string): string {
  if (!ACCOUNT.test(account)) throw new Error("not a sync account");
  return join(dataDirectory(), "Sync", `sync-key-${account}`);
}

export const keyPersists = (): boolean => KEYRINGS.has(safeStorage.getSelectedStorageBackend());

export async function saveKey(account: string, entropy: Uint8Array): Promise<boolean> {
  try {
    const path = keyPath(account);
    if (!keyPersists()) {
      keptUntilQuit.set(account, Buffer.from(entropy));
      note("sync", `no keyring (${safeStorage.getSelectedStorageBackend()}): the sync key is kept until Ardia quits`);
      return true;
    }
    const stored: StoredKey = { version: 1, backend: safeStorage.getSelectedStorageBackend(), sealed: safeStorage.encryptString(Buffer.from(entropy).toString("hex")).toString("base64") };
    await mkdir(join(dataDirectory(), "Sync"), { recursive: true, mode: 0o700 });
    await saveFile(path, Buffer.from(JSON.stringify(stored), "utf8"), 0o600);
    keptUntilQuit.delete(account);
    return true;
  } catch (error) {
    note("sync", `the sync key couldn't be saved: ${String(error)}`);
    return false;
  }
}

export async function loadKey(account: string): Promise<Buffer | null> {
  const kept = keptUntilQuit.get(account);
  if (kept) return Buffer.from(kept);
  let stored: StoredKey;
  try {
    stored = JSON.parse(await readFile(keyPath(account), "utf8")) as StoredKey;
  } catch {
    return null;
  }
  if (!KEYRINGS.has(stored.backend)) {
    note("sync", `deleting a sync key sealed without a keyring (${stored.backend}); the recovery phrase unlocks sync again`);
    await rm(keyPath(account), { force: true }).catch(() => {});
    return null;
  }
  try {
    const entropy = Buffer.from(safeStorage.decryptString(Buffer.from(stored.sealed, "base64")), "hex");
    return entropy.length === KEY_BYTES ? entropy : null;
  } catch (error) {
    note("sync", `the sync key couldn't be opened (${stored.backend}): ${String(error)}`);
    return null;
  }
}

export async function deleteKey(account: string): Promise<void> {
  keptUntilQuit.delete(account);
  if (!ACCOUNT.test(account)) return;
  await rm(keyPath(account), { force: true }).catch(() => {});
}
