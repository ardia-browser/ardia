import { safeStorage } from "electron";
import { writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { defineModule } from "../bridge";
import { defineDomain } from "../engine/domains";
import { pref, savedDatabase, setPref, transaction } from "./database";
import { askSavePath } from "./dialogs";
import { ensureEncryption, keyringAvailable, secretProtection, sealedWithoutKeyring } from "../secretStorage";
import { engineError, originalProfile } from "./profiles";
import { confirmDeviceOwner } from "../ownerCheck";

export type Login = { origin: string; username: string; password: string; created: number; modified: number; used: number | null };
type StoredLogin = { origin: string; username: string; password: Uint8Array; created: number; modified: number; used: number | null };

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const ENABLED_PREF = "passwords.enabled";
const PASSWORD_FILE_WARNING = "Anyone who can open this file can read your passwords.";

export function loginOrigin(spec: string): string | null {
  try {
    const url = new URL(spec);
    if (!Object.hasOwn(DEFAULT_PORTS, url.protocol) || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const store = (profile: string): DatabaseSync => savedDatabase(originalProfile(profile));

export const encryptionReady = (): boolean => ensureEncryption();

function encrypt(password: string): Buffer {
  if (!encryptionReady()) throw engineError("passwords can't be encrypted on this system");
  return safeStorage.encryptString(password);
}

function decrypt(blob: Uint8Array): string {
  encryptionReady();
  return safeStorage.decryptString(Buffer.from(blob));
}

const stored = (db: DatabaseSync, origin: string, username: string) =>
  db.prepare("SELECT * FROM logins WHERE origin = ? AND username = ?").get(origin, username) as StoredLogin | undefined;

function opened(profile: string, row: StoredLogin): Login {
  const password = decrypt(row.password);
  if (sealedWithoutKeyring(row.password) && keyringAvailable())
    store(profile).prepare("UPDATE logins SET password = ? WHERE origin = ? AND username = ?").run(encrypt(password), row.origin, row.username);
  return { ...row, password };
}

export function loginsFor(profile: string, origin: string): Login[] {
  const rows = store(profile).prepare("SELECT * FROM logins WHERE origin = ? ORDER BY COALESCE(used, modified) DESC").all(origin) as StoredLogin[];
  return rows.flatMap((row) => {
    try {
      return [opened(profile, row)];
    } catch {
      return [];
    }
  });
}

export function allLogins(profile: string): Login[] {
  const rows = store(profile).prepare("SELECT * FROM logins ORDER BY origin, username").all() as StoredLogin[];
  return rows.map((row) => opened(profile, row));
}

export function passwordsEnabled(profile: string): boolean {
  return pref(store(profile), ENABLED_PREF, true);
}

export function neverSaves(profile: string, origin: string): boolean {
  return !!store(profile).prepare("SELECT 1 FROM never_save WHERE origin = ?").get(origin);
}

export function neverSave(profile: string, origin: string): void {
  store(profile).prepare("INSERT OR IGNORE INTO never_save (origin) VALUES (?)").run(origin);
}

export function markUsed(profile: string, origin: string, username: string): void {
  store(profile).prepare("UPDATE logins SET used = ? WHERE origin = ? AND username = ?").run(Date.now(), origin, username);
}

export function putLogin(profile: string, originSpec: string, username: string, password: string, replace: boolean): void {
  const origin = loginOrigin(originSpec);
  if (!origin || !password) throw engineError("Could not save the password (invalid, or already saved)");
  const db = store(profile);
  const now = Date.now();
  transaction(db, () => {
    const existing = stored(db, origin, username);
    if (existing && !replace) {
      if (decrypt(existing.password) !== password) throw engineError("Could not save the password (invalid, or already saved)");
      return;
    }
    db.prepare(
      "INSERT INTO logins (origin, username, password, created, modified, used) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin, username) DO UPDATE SET password = excluded.password, modified = excluded.modified, used = excluded.used",
    ).run(origin, username, encrypt(password), now, now, now);
  });
}

export function updateLogin(profile: string, originSpec: string, username: string, newUsername: string | null, newPassword: string | null): void {
  const origin = loginOrigin(originSpec);
  const db = store(profile);
  transaction(db, () => {
    const existing = origin ? stored(db, origin, username) : undefined;
    if (!origin || !existing) throw engineError("No such password");
    const renamed = newUsername ?? username;
    if (renamed !== username && stored(db, origin, renamed)) throw engineError("A password for that username is already saved");
    const password = newPassword === null ? Buffer.from(existing.password) : encrypt(newPassword);
    db.prepare("UPDATE logins SET username = ?, password = ?, modified = ? WHERE origin = ? AND username = ?").run(renamed, password, Date.now(), origin, username);
  });
}

const csvField = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

async function exportCsv(profile: string) {
  const db = store(profile);
  const rows = db.prepare("SELECT * FROM logins ORDER BY origin, username").all() as StoredLogin[];
  const lines = ["name,url,username,password,note"];
  for (const row of rows) {
    let password: string;
    try {
      password = decrypt(row.password);
    } catch {
      continue;
    }
    lines.push([new URL(row.origin).hostname, `${row.origin}/`, row.username, password, ""].map(csvField).join(","));
  }
  const path = await askSavePath("Ardia Passwords.csv", [{ name: "CSV file", extensions: ["csv"] }], PASSWORD_FILE_WARNING);
  if (!path) return { status: "cancelled" };
  try {
    await writeFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return { status: "succeeded", path };
  } catch {
    return { status: "writeFailed" };
  }
}

const text = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  if (typeof value !== "string") throw engineError(`${key} is missing`);
  return value;
};

defineDomain("passwords", {
  list: (_args, profile) => ({
    passwords: (store(profile).prepare("SELECT origin, username, created, modified FROM logins ORDER BY origin, username").all() as Omit<StoredLogin, "password">[]).map(
      (row) => ({ origin: row.origin, username: row.username, created: Math.floor(row.created), modified: Math.floor(row.modified) }),
    ),
  }),
  unlock: async () => ({ unlocked: encryptionReady() && (await confirmDeviceOwner("show your saved passwords")) }),
  protection: () => secretProtection(),
  reveal: (args, profile) => {
    const origin = loginOrigin(text(args, "origin"));
    const row = origin ? stored(store(profile), origin, text(args, "username")) : undefined;
    return { password: row ? decrypt(row.password) : null };
  },
  remove: (args, profile) => {
    const origin = loginOrigin(text(args, "origin"));
    if (origin) store(profile).prepare("DELETE FROM logins WHERE origin = ? AND username = ?").run(origin, text(args, "username"));
    return { ok: true };
  },
  neverSaveOrigins: (_args, profile) => ({ origins: (store(profile).prepare("SELECT origin FROM never_save ORDER BY origin").all() as { origin: string }[]).map((row) => row.origin) }),
  allowSaving: (args, profile) => {
    const origin = loginOrigin(text(args, "origin")) ?? text(args, "origin");
    store(profile).prepare("DELETE FROM never_save WHERE origin = ?").run(origin);
    return { ok: true };
  },
  export: (_args, profile) => exportCsv(profile),
  autofillEnabled: (_args, profile) => passwordsEnabled(profile),
  setAutofillEnabled: (args, profile) => {
    setPref(store(profile), ENABLED_PREF, args.enabled === true);
    return null;
  },
});

const ok = () => JSON.stringify({ ok: true });

defineModule("ArdiaPasswords", {
  async: {
    save: async (profile: string, origin: string, username: string, password: string) => {
      putLogin(profile ?? "", origin ?? "", username ?? "", password ?? "", false);
      return ok();
    },
    update: async (profile: string, origin: string, username: string, newUsername: string | null, newPassword: string | null) => {
      updateLogin(profile ?? "", origin ?? "", username ?? "", typeof newUsername === "string" ? newUsername : null, typeof newPassword === "string" ? newPassword : null);
      return ok();
    },
  },
});
