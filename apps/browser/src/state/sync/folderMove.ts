import { parseSyncFile, SyncNative, type FolderInfo, type Listing } from "../../platform/sync";
import { errorText } from "../../lib/errors";
import { onConsentPeriodChange } from "../telemetry/choice";
import { APP_SCOPE, type SyncDoc } from "./syncDoc";
import { PROFILE, profileScope } from "./records";

export const SYNC_FOLDER_NAME = "Ardia Sync";
const DAMAGED_GIVEN_UP_MS = 86_400_000;

export type FolderMoveResult =
  | { ok: "moved" | "joined" | "same" }
  | { error: "otherData" | "nested" | "arriving" | "unreadable" | "notWritable" | "busy" | "locked" }
  | { error: "failed"; message: string };

export type TurnOnFolder = "picked" | "kept";

const NO_FOLDER_COUNTS = { picked: 0, kept: 0, moved: 0, joined: 0, refused: 0 };
let folderCounts = { ...NO_FOLDER_COUNTS };

onConsentPeriodChange(() => (folderCounts = { ...NO_FOLDER_COUNTS }));

export function noteTurnOn(how: TurnOnFolder | undefined) {
  if (how) folderCounts[how]++;
}

export function noteFolderMove(result: FolderMoveResult): FolderMoveResult {
  if (!("ok" in result)) folderCounts.refused++;
  else if (result.ok !== "same") folderCounts[result.ok]++;
  return result;
}

export function takeFolderCounts() {
  const taken = folderCounts;
  folderCounts = { ...NO_FOLDER_COUNTS };
  return taken;
}

export function folderScopes(doc: SyncDoc): string[] {
  const listed = Object.keys(doc.scopes[APP_SCOPE]?.records ?? {}).filter((key) => key.startsWith(PROFILE)).map((key) => profileScope(key.slice(PROFILE.length)));
  const linked = Object.values(doc.profiles).map((link) => profileScope(link.syncId));
  return [...new Set([APP_SCOPE, ...Object.keys(doc.scopes), ...linked, ...listed])];
}

export type FolderMoveNative = {
  folderInfo(path: string | null): Promise<FolderInfo>;
  chainStatus(folder: string): Promise<"ok" | "missing" | "unavailable">;
  createChain(folder: string): Promise<void>;
  read(folder: string, scope: string, known: string[]): Promise<Listing>;
  write(folder: string, scope: string, payload: string): Promise<string>;
  remove(folder: string, scope: string, ids: string[]): Promise<void>;
};

const trimmed = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export const parentFolder = (path: string) => {
  const clean = trimmed(path);
  const cut = clean.lastIndexOf("/");
  return cut > 0 ? clean.slice(0, cut) : "/";
};

const baseName = (path: string) => trimmed(path).split("/").pop() ?? "";
const within = (inner: string, outer: string) => trimmed(inner).startsWith(`${trimmed(outer)}/`);
export const samePath = (a: string, b: string) => trimmed(a) === trimmed(b);

export async function syncFolderAt(picked: string, info: (path: string) => Promise<FolderInfo | null>): Promise<string> {
  const folder = trimmed(picked);
  if ((await info(folder))?.hasSyncData) return folder;
  const inside = `${folder === "/" ? "" : folder}/${SYNC_FOLDER_NAME}`;
  if ((await info(inside))?.hasSyncData) return inside;
  return baseName(folder) === SYNC_FOLDER_NAME ? folder : inside;
}

export async function pickSyncFolder(current: string | null): Promise<string | null> {
  const native = SyncNative;
  if (!native) return null;
  const start = current ?? (await native.folderInfo(null)).defaultPath;
  const picked = await native.chooseFolder(parentFolder(start));
  return picked ? syncFolderAt(picked, (path) => native.folderInfo(path).catch(() => null)) : null;
}

export function listedProfileScopes(appFiles: Listing["files"]): string[] {
  const scopes = new Set<string>();
  for (const { payload } of appFiles) {
    const file = parseSyncFile(payload);
    const keys = !file ? [] : file.kind === "snapshot" ? Object.keys(file.records) : file.ops.map((op) => op.k);
    for (const key of keys) if (key.startsWith(PROFILE)) scopes.add(profileScope(key.slice(PROFILE.length)));
  }
  return [...scopes];
}

const stillArriving = (listing: Listing) => listing.pending.length > 0 || listing.damaged.some((file) => file.age < DAMAGED_GIVEN_UP_MS);

export async function moveChain(native: FolderMoveNative, from: string, to: string, scopes: readonly string[]): Promise<FolderMoveResult> {
  if (samePath(from, to)) return { ok: "same" };
  if (within(to, from) || within(from, to)) return { error: "nested" };
  const target = await native.folderInfo(to);
  const ours = (await native.chainStatus(to)) === "ok";
  if (!ours && target.hasSyncData) return { error: "otherData" };
  if (target.exists && !target.writable) return { error: "notWritable" };
  if ((await native.chainStatus(from)) !== "ok") return ours && (await native.read(to, APP_SCOPE, [])).present.length ? { ok: "joined" } : { error: "unreadable" };
  const copies: [string, Listing["files"]][] = [];
  try {
    const app = await native.read(from, APP_SCOPE, []);
    for (const scope of new Set([APP_SCOPE, ...scopes, ...listedProfileScopes(app.files)])) {
      const listing = scope === APP_SCOPE ? app : await native.read(from, scope, []);
      if (stillArriving(listing)) return { error: "arriving" };
      copies.push([scope, listing.files]);
    }
  } catch {
    return { error: "unreadable" };
  }
  let missing: [string, string[]][];
  try {
    if (!ours) await native.createChain(to);
    missing = ours ? await missingFrom(native, to, copies) : copies.map(([scope, files]) => [scope, files.map((file) => file.payload)]);
  } catch (error) {
    return { error: "failed", message: errorText(error) };
  }
  if (ours && missing.every(([, payloads]) => !payloads.length)) return { ok: "joined" };
  const written = new Map<string, string[]>();
  try {
    for (const [scope, payloads] of missing) {
      const ids: string[] = [];
      written.set(scope, ids);
      for (const payload of payloads) ids.push(await native.write(to, scope, payload));
    }
    const left = await missingFrom(native, to, copies);
    if (left.some(([, payloads]) => payloads.length)) throw new Error("the copied files don’t match the originals");
  } catch (error) {
    await undoCopy(native, to, written);
    return { error: "failed", message: errorText(error) };
  }
  return { ok: "moved" };
}

async function missingFrom(native: FolderMoveNative, folder: string, copies: [string, Listing["files"]][]): Promise<[string, string[]][]> {
  const missing: [string, string[]][] = [];
  for (const [scope, files] of copies) {
    const there = new Set((await native.read(folder, scope, [])).files.map((file) => file.payload));
    missing.push([scope, files.map((file) => file.payload).filter((payload) => !there.has(payload))]);
  }
  return missing;
}

async function undoCopy(native: FolderMoveNative, to: string, written: Map<string, string[]>) {
  for (const [scope, ids] of written) if (ids.length) await native.remove(to, scope, ids).catch(() => {});
}

export function folderMoveMessage(result: FolderMoveResult, label: string, previous: string): string {
  if ("ok" in result) {
    if (result.ok === "moved") return `Moved. Sync now uses ${label}. The old folder at ${previous} stays as it was for devices that still sync through it; delete it once they’ve moved too.`;
    if (result.ok === "joined") return `Sync now uses ${label}, which already holds this sync data.`;
    return `Sync already uses ${label}.`;
  }
  switch (result.error) {
    case "otherData":
      return "That folder holds sync data from a different recovery phrase. Choose an empty folder, or the one your other devices sync through.";
    case "nested":
      return "Choose a folder that isn’t inside the current sync folder, and doesn’t hold it.";
    case "arriving":
      return "Some sync files are still downloading into the current folder. Try again once they’ve arrived.";
    case "unreadable":
      return "The current sync folder can’t be read, so its files can’t be copied. Choose the folder that holds them now.";
    case "notWritable":
      return "Ardia can’t write to that folder. Choose another one.";
    case "busy":
      return "Sync is busy. Try again in a moment.";
    case "locked":
      return "Enter your recovery phrase before moving the sync folder.";
    case "failed":
      return `Couldn’t move the sync folder: ${result.message}. Sync still uses ${previous}.`;
  }
}
