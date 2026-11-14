import { app, clipboard, ClipboardItem, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineModule } from "../../bridge";
import { launchConfig, testValue } from "../../launch";
import { note } from "../../log";
import { isBackground } from "../../paths";
import { allLogins, putLogin } from "../passwords";
import { newFileId, SyncKeys } from "./crypto.ts";
import { deleteKey, loadKey, saveKey } from "./keyStore";
import { KIT_PDF_NAME, kitBytes, kitPreview, qrDataUrl } from "./kit";
import { hidePasswords } from "./logins.ts";
import { entropyFrom, newEntropy, wordsFor } from "./phrase.ts";
import { failure, folderState, hasSyncData, saveFile, SyncVault } from "./vault.ts";

const FOLDER_NAME = "Ardia Sync";
const CLOUD_FOLDERS = ["Dropbox", "Nextcloud", "ownCloud", "OneDrive", "pCloudDrive", "Google Drive", "MEGA", "Sync", "Syncthing"];
const LOCKED = "Sync isn't set up on this computer.";
const UNREADABLE = "This computer's sync state couldn't be read safely, so sync is paused to keep it.";

type Session = { account: string; entropy: Buffer; keys: SyncKeys; generation: number; localUnreadable: boolean } | null;

let session: Session = null;
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();

function serially<Value>(work: () => Promise<Value>): Promise<Value> {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

function setSession(account: string | null, entropy: Buffer | null): void {
  generation++;
  session = account && entropy ? { account, entropy, keys: new SyncKeys(entropy), generation, localUnreadable: false } : null;
}

function unlocked(): NonNullable<Session> {
  if (!session) throw failure(LOCKED, "locked");
  return session;
}

function writable(): NonNullable<Session> {
  const current = unlocked();
  if (current.localUnreadable) throw failure(UNREADABLE, "unreadable");
  return current;
}

const vault = (folder: string) => new SyncVault(folder, unlocked().keys);

function testFolder(): string | null {
  const config = launchConfig();
  return config.testInstance ? (config.instance.syncFolder ?? null) : null;
}

function cloudFolder(): string | null {
  for (const name of CLOUD_FOLDERS) {
    const path = join(homedir(), name);
    if (existsSync(path)) return path;
  }
  return null;
}

function defaultFolder(): { path: string; cloud: string | null } {
  const test = testFolder();
  if (test) return { path: test, cloud: test };
  const cloud = cloudFolder();
  return { path: join(cloud ?? homedir(), FOLDER_NAME), cloud };
}

const inside = (path: string, root: string | null) => !!root && (path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`));

function deviceName(): string {
  try {
    const pretty = /^PRETTY_HOSTNAME=(.*)$/m.exec(readFileSync("/etc/machine-info", "utf8"))?.[1]?.replace(/^["']|["']$/g, "").trim();
    if (pretty) return pretty;
  } catch {}
  return hostname() || "This computer";
}

const osFormat = (format: string) => `electron application/osclipboard;format="${format}"`;

const kitFolder = () => join(tmpdir(), `Ardia Recovery Kit-${process.getuid?.() ?? 0}`);

function ownerAllows(reason: string): boolean {
  const answer = testValue("reauth");
  if (answer === undefined) return true;
  note("sync", `device owner check (${reason}) in a test instance: ${answer === "denied" ? "denied" : "granted"}`);
  return answer !== "denied";
}

function disclosedWords(reason: string): string[] | null {
  const current = unlocked();
  if (!ownerAllows(reason)) return null;
  return wordsFor(current.entropy);
}

const LOGIN_ORIGIN = /^https?:\/\/[^/\s]+$/;

function sealedLogins(profile: string) {
  const current = session;
  if (!current) return null;
  try {
    const seen = new Set<string>();
    const sealed: { origin: string; username: string; sealed: string; created: number }[] = [];
    for (const login of allLogins(profile)) {
      const origin = login.origin.replace(/\/$/, "");
      if (seen.has(`${origin}\0${login.username}`) || !LOGIN_ORIGIN.test(origin)) continue;
      seen.add(`${origin}\0${login.username}`);
      sealed.push({ origin, username: login.username, sealed: current.keys.sealPassword(login.password, origin, login.username), created: login.created });
    }
    return sealed;
  } catch (error) {
    note("sync", `reading passwords: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

app.whenReady().then(() => rm(kitFolder(), { recursive: true, force: true }).catch(() => {}));

defineModule("ArdiaSync", {
  sync: {
    newDeviceId: () => newFileId(),
    deviceName,
    takeFileCounts: () => ({ placeholders: 0, busy: 0, hydrated: 0 }),
  },
  async: {
    async folderInfo(path: string | null) {
      const fallback = defaultFolder();
      const chosen = path ?? fallback.path;
      const state = await folderState(chosen);
      const cloud = cloudFolder();
      return {
        path: chosen,
        defaultPath: fallback.path,
        iCloudAvailable: !!fallback.cloud,
        inICloud: inside(chosen, testFolder() ?? cloud),
        exists: state.exists,
        writable: state.exists && state.writable,
        hasSyncData: state.exists && state.hasSyncData,
      };
    },
    createPhrase: (account: string) =>
      serially(async () => {
        const entropy = newEntropy();
        if (!(await saveKey(account, entropy))) return false;
        setSession(account, entropy);
        return true;
      }),
    enterPhrase: (account: string, text: string, folder: string) =>
      serially(async () => {
        const parsed = entropyFrom(String(text ?? ""));
        if (!Buffer.isBuffer(parsed)) return parsed;
        if (!(await new SyncVault(folder, new SyncKeys(parsed)).chainExists())) return { error: (await hasSyncData(folder)) ? "mismatch" : "noData" };
        if (!(await saveKey(account, parsed))) return { error: "keychain" };
        setSession(account, parsed);
        return { ok: true };
      }),
    unlock: (account: string) =>
      serially(async () => {
        const entropy = await loadKey(account);
        if (!entropy) return false;
        setSession(account, entropy);
        return true;
      }),
    forget: (account: string) =>
      serially(async () => {
        await deleteKey(account);
        setSession(null, null);
      }),
    chainStatus: (folder: string) => serially(() => vault(folder).chainStatus()),
    createChain: (folder: string) => serially(() => vault(folder).createChain()),
    deleteChain: (folder: string) => serially(() => vault(folder).deleteChain()),
    write: (folder: string, scope: string, payload: string) =>
      serially(() => {
        writable();
        return vault(folder).write(scope, payload);
      }),
    read: (folder: string, scope: string, known: string[]) => serially(() => vault(folder).read(scope, Array.isArray(known) ? known : [])),
    remove: (folder: string, scope: string, ids: string[]) => serially(() => vault(folder).remove(scope, Array.isArray(ids) ? ids : [])),
    async sealLocal(text: string) {
      return writable().keys.seal(Buffer.from(String(text), "utf8"), "local", "state").toString("base64");
    },
    async openLocal(sealed: string) {
      const current = session;
      if (!current || typeof sealed !== "string") return null;
      let plain: string;
      try {
        plain = current.keys.open(Buffer.from(sealed, "base64"), "local", "state").toString("utf8");
      } catch {
        return null;
      }
      const hidden = hidePasswords(plain, current.keys);
      if (hidden === null && session?.generation === current.generation) current.localUnreadable = true;
      return hidden;
    },
    recoveryWords: async () => disclosedWords("show your sync recovery phrase"),
    async qrCode() {
      const words = disclosedWords("show your sync recovery phrase");
      return words ? qrDataUrl(words) : null;
    },
    async recoveryKitPreview(width: number) {
      unlocked();
      return kitPreview(Number(width) || 168, new Date(), deviceName());
    },
    async writeRecoveryKit(path: string, format: "pdf" | "text") {
      const words = disclosedWords("save your sync recovery kit");
      if (!words) return null;
      await saveFile(path, kitBytes(words, format === "text" ? "text" : "pdf", deviceName()), 0o600);
      return path;
    },
    async copyRecoveryKit() {
      const words = disclosedWords("copy your sync recovery kit");
      if (!words) return null;
      const folder = kitFolder();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, KIT_PDF_NAME);
      await saveFile(path, kitBytes(words, "pdf", deviceName()), 0o600);
      const uri = pathToFileURL(path).href;
      await clipboard.write([new ClipboardItem({ [osFormat("x-special/gnome-copied-files")]: `copy\n${uri}`, [osFormat("text/uri-list")]: `${uri}\r\n`, "text/plain": path })]);
      return true;
    },
    shareRecoveryKit: async () => false,
    async copyRecoveryPhrase() {
      const words = disclosedWords("copy your sync recovery phrase");
      if (!words) return null;
      await clipboard.write([new ClipboardItem({ "text/plain": words.join(" "), [osFormat("x-kde-passwordManagerHint")]: "secret" })]);
      return true;
    },
    async revealFolder(path: string) {
      if (typeof path !== "string" || !existsSync(path) || isBackground()) return;
      shell.showItemInFolder(path);
    },
    readPasswords: async (engineProfile: string) => sealedLogins(String(engineProfile ?? "")),
    async savePassword(engineProfile: string, origin: string, username: string, sealed: string, replacing: boolean) {
      const current = session;
      let password: string;
      try {
        if (!current) throw new Error(LOCKED);
        password = current.keys.openPassword(sealed, origin, username);
      } catch {
        note("sync", "a synced password didn't open for its login; not saving it");
        return false;
      }
      try {
        putLogin(String(engineProfile ?? ""), origin, username, password, replacing === true);
        return session?.generation === current.generation;
      } catch (error) {
        note("sync", `saving a synced password: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  },
});
