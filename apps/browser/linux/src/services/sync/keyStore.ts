import { safeStorage } from "electron";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { note } from "../../log";
import { dataDirectory } from "../../paths";
import { encryptionReady } from "../passwords";
import { KEY_BYTES } from "./crypto.ts";
import { saveFile } from "./vault.ts";

type StoredKey = { version: 1; backend: string; sealed: string };

const ACCOUNT = /^[a-z2-7]{1,64}$/;

function keyPath(account: string): string {
  if (!ACCOUNT.test(account)) throw new Error("not a sync account");
  return join(dataDirectory(), "Sync", `sync-key-${account}`);
}

export async function saveKey(account: string, entropy: Uint8Array): Promise<boolean> {
  try {
    if (!encryptionReady()) return false;
    const stored: StoredKey = { version: 1, backend: safeStorage.getSelectedStorageBackend(), sealed: safeStorage.encryptString(Buffer.from(entropy).toString("hex")).toString("base64") };
    const path = keyPath(account);
    await mkdir(join(dataDirectory(), "Sync"), { recursive: true, mode: 0o700 });
    await saveFile(path, Buffer.from(JSON.stringify(stored), "utf8"), 0o600);
    return true;
  } catch (error) {
    note("sync", `the sync key couldn't be saved: ${String(error)}`);
    return false;
  }
}

export async function loadKey(account: string): Promise<Buffer | null> {
  let stored: StoredKey;
  try {
    stored = JSON.parse(await readFile(keyPath(account), "utf8")) as StoredKey;
  } catch {
    return null;
  }
  try {
    encryptionReady();
    const entropy = Buffer.from(safeStorage.decryptString(Buffer.from(stored.sealed, "base64")), "hex");
    return entropy.length === KEY_BYTES ? entropy : null;
  } catch (error) {
    note("sync", `the sync key couldn't be opened (${stored.backend}): ${String(error)}`);
    return null;
  }
}

export async function deleteKey(account: string): Promise<void> {
  await rm(keyPath(account), { force: true }).catch(() => {});
}
