import { cleanLinkTitle, cleanUrl } from "@ardia/core";
import { confirm, pickFolder } from "../../platform/dialogs";
import { configDirectory } from "../../platform/launchConfig";
import { filesRevoke, pluginFolderCreate, pluginFolderInfo, pluginsFolder, type PluginFolderCreateResult, type PluginFolderInfo } from "../../platform/plugins";
import { secureRandomHex } from "../../platform/secureRandom";
import { sharePage } from "../../platform/share";
import { sharedFoldersAvailable, sharedLocation } from "../../platform/sharedFolders";
import { errorText } from "../../lib/errors";
import type { PluginManifest } from "../../lib/pluginManifest";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { useBrowser } from "../browser/store";
import { failure } from "../automation/automationMethods";
import { lastFocusedEligibleWindow } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { fileUrlOf } from "../sharedFolders/actions";
import { dropFileWatches } from "./channelFiles";
import { folderNameProblem, grantIdentity, isGrantId, MAX_FOLDER_GRANTS } from "./folderGrants";
import { updateRecord } from "./lifecycle";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins, NO_RECORD, recordOf, type PluginFolderGrant } from "./store";

export const FOLDERS_METHODS = ["folders.list", "folders.create", "folders.pick", "folders.share", "folders.forget"] as const;

const PROMPT_MAX = 40;
const ASKING = "This plugin is already asking about a folder. Wait for that answer first.";
const UNSAVED = "plugins.json couldn't be saved, so the folder wasn't added.";

type Caller = { name: string; run: number };
type FolderGrantView = { id: string; name: string; location: "icloud" | "other"; available: boolean };

const asking = new Set<string>();

const grantsOf = (name: string) => recordOf(currentPlugins(), name).folders ?? {};

const viewOf = (id: string, grant: PluginFolderGrant, available: boolean): FolderGrantView => ({ id, name: grant.name, location: grant.location, available });

const folderInfo = (path: string): Promise<PluginFolderInfo> => pluginFolderInfo(path).catch((): PluginFolderInfo => ({ exists: false, realPath: path, location: "other", protected: false }));

const stillAllowed = (c: Caller) => acceptsRun(c.name, c.run) && !!activeManifest(currentPlugins(), c.name)?.permissions.folders;

const within = (path: string, folder: string) => !!folder && (path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`));

function ardiaOwnFolders(): string[] {
  const own: string[] = [];
  try {
    own.push(configDirectory());
  } catch {}
  try {
    own.push(pluginsFolder());
  } catch {}
  return own.filter((p) => typeof p === "string" && p.startsWith("/")).map((p) => p.replace(/\/+$/, ""));
}

export const isArdiaOwnFolder = (path: string): boolean => ardiaOwnFolders().some((own) => within(path, own) || within(own, path));

const isProtected = (info: PluginFolderInfo) => info.protected === true || isArdiaOwnFolder(info.realPath);

const isIdentityPart = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const identityOf = (info: PluginFolderInfo) => (isIdentityPart(info.device) && isIdentityPart(info.inode) ? { device: info.device, inode: info.inode } : {});

function isGrantedFolder(grant: PluginFolderGrant, info: PluginFolderInfo): boolean {
  if (!info.exists || info.realPath !== grant.path) return false;
  const kept = grantIdentity(grant);
  return !kept || (info.device === kept.device && info.inode === kept.inode);
}

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

function newGrantId(name: string): string {
  const taken = grantsOf(name);
  let id = `f${secureRandomHex(10)}`;
  while (Object.hasOwn(taken, id)) id = `f${secureRandomHex(10)}`;
  return id;
}

function grant(c: Caller, info: PluginFolderInfo, consent: ConsentToken | null): Body {
  const name = c.name;
  if (!stillAllowed(c)) return failure("refused", "The plugin stopped or lost the folders permission before the folder could be added.");
  const existing = Object.entries(grantsOf(name)).find(([, g]) => g.path === info.realPath);
  if (existing && (isGrantedFolder(existing[1], info) || !info.exists)) return { result: { folder: viewOf(existing[0], existing[1], info.exists) } };
  if (existing) {
    const [id, kept] = existing;
    const regranted = { ...kept, ...identityOf(info) };
    const saved = updateRecord(name, (r) => (r.folders && Object.hasOwn(r.folders, id) ? { ...r, folders: { ...r.folders, [id]: regranted } } : r), consent);
    if (!saved) return failure("failed", UNSAVED);
    dropFileWatches(name, id);
    filesRevoke(name, kept.path);
    return { result: { folder: viewOf(id, regranted, true) } };
  }
  if (Object.keys(grantsOf(name)).length >= MAX_FOLDER_GRANTS) return failure("refused", `A plugin may use at most ${MAX_FOLDER_GRANTS} folders; forget one first.`);
  if (!isIdentityPart(info.device) || !isIdentityPart(info.inode)) return failure("unavailable", "That folder couldn't be identified, so it wasn't added.");
  const id = newGrantId(name);
  const added: PluginFolderGrant = { name: baseName(info.realPath), path: info.realPath, location: info.location === "icloud" ? "icloud" : "other", addedAt: Date.now(), ...identityOf(info) };
  const saved = updateRecord(name, (r) => (r === NO_RECORD ? null : { ...r, folders: { ...(r.folders ?? {}), [id]: added } }), consent);
  if (!saved || !Object.hasOwn(grantsOf(name), id)) return failure("failed", UNSAVED);
  notePlugin("plugin_folder_grants", consent);
  return { result: { folder: viewOf(id, added, info.exists) } };
}

async function list(c: Caller): Promise<Body> {
  const entries = Object.entries(grantsOf(c.name)).sort((a, b) => a[1].addedAt - b[1].addedAt);
  const infos = await Promise.all(entries.map(([, g]) => folderInfo(g.path)));
  return { result: { folders: entries.map(([id, g], i) => viewOf(id, g, isGrantedFolder(g, infos[i]!))) } };
}

async function asked<T>(c: Caller, work: (windowId: string) => Promise<T>): Promise<T | Body> {
  if (asking.has(c.name)) return failure("failed", ASKING);
  const windowId = lastFocusedEligibleWindow(useBrowser.getState());
  if (!windowId) return failure("no_window", "No window to ask in.");
  asking.add(c.name);
  try {
    return await work(windowId);
  } finally {
    asking.delete(c.name);
  }
}

const isBody = (value: unknown): value is Body => typeof value === "object" && value !== null && ("result" in value || "error" in value);

type FolderIdentity = { device: number; inode: number };
type CapturedParent = { target: string; identity: FolderIdentity | null; grandparent: FolderIdentity | null };

const PROTECTED_FOLDER = "That folder holds Ardia's own data or your whole home or Library, so a plugin can't use it.";

const withoutPrivate = (path: string) => path.replace(/\/+$/, "").replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "");

async function checkedFolder(path: string): Promise<{ realPath: string; identity: FolderIdentity } | null | Body> {
  const info = await folderInfo(path);
  if (isArdiaOwnFolder(path) || info.protected || isArdiaOwnFolder(info.realPath)) return failure("refused", PROTECTED_FOLDER);
  if (!info.exists) return null;
  if (withoutPrivate(info.realPath) !== withoutPrivate(path)) return failure("refused", "That folder is a link to another one, so Ardia won't make a folder through it.");
  if (!isIdentityPart(info.device) || !isIdentityPart(info.inode)) return failure("unavailable", "That folder couldn't be identified, so nothing was made in it.");
  return { realPath: info.realPath, identity: { device: info.device, inode: info.inode } };
}

async function capturedParent(path: string): Promise<CapturedParent | Body> {
  const parent = await checkedFolder(path);
  if (isBody(parent)) return parent;
  if (parent) return { target: parent.realPath, identity: parent.identity, grandparent: null };
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const name = trimmed.slice(cut + 1);
  if (cut < 0 || !name || folderNameProblem(name)) return failure("unavailable", "That folder can't be found.");
  const enclosing = await checkedFolder(trimmed.slice(0, cut) || "/");
  if (isBody(enclosing)) return enclosing;
  if (!enclosing) return failure("unavailable", "The folder that holds it can't be found.");
  return { target: `${enclosing.realPath.replace(/\/+$/, "")}/${name}`, identity: null, grandparent: enclosing.identity };
}

async function parentFor(m: PluginManifest, name: string, windowId: string): Promise<CapturedParent | null | Body> {
  if (!sharedFoldersAvailable()) return failure("unavailable", "Shared folders aren't available here.");
  const location = sharedLocation();
  const title = `${m.title} wants to create a shared folder`;
  if (location.iCloudAvailable) {
    const parent = await capturedParent(location.path);
    if (isBody(parent)) return parent;
    const answer = await confirm({ title, message: `It makes “${name}” in ${PLATFORM_TERMS.cloudDrive} › Ardia Shared, which you can then share with people. Ardia never deletes it.`, confirmTitle: "Create Folder", windowId, sheetOnly: true });
    if (answer.unavailable === true) return failure("no_window", "No visible window to show the dialog.");
    return answer.confirmed === true ? parent : null;
  }
  const answer = await confirm({
    title,
    message: `${PLATFORM_TERMS.cloudDrive} is off, so “${name}” goes in a folder you choose; pick one that syncs, like one in Dropbox, to share it with people. Ardia never deletes it.`,
    confirmTitle: "Choose Folder…",
    windowId,
    sheetOnly: true,
  });
  if (answer.unavailable === true) return failure("no_window", "No visible window to show the dialog.");
  if (answer.confirmed !== true) return null;
  const picked = await pickFolder(null, "Use Folder");
  return picked ? capturedParent(picked) : null;
}

async function create(c: Caller, m: PluginManifest, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const problem = folderNameProblem(params.name);
  if (problem) return failure("bad_request", problem);
  if (Object.keys(grantsOf(c.name)).length >= MAX_FOLDER_GRANTS) return failure("refused", `A plugin may use at most ${MAX_FOLDER_GRANTS} folders; forget one first.`);
  const name = params.name as string;
  const outcome = await asked(c, async (windowId): Promise<Body> => {
    const parent = await parentFor(m, name, windowId);
    if (isBody(parent)) return parent;
    if (!parent) return { result: { folder: null } };
    if (!stillAllowed(c)) return failure("refused", "The plugin stopped or lost the folders permission while you were deciding.");
    let made: PluginFolderCreateResult;
    try {
      made = await pluginFolderCreate(parent.target, parent.identity, name, parent.grandparent);
    } catch (error) {
      return failure("failed", errorText(error));
    }
    if (!made.ok) return failure(made.code, made.message);
    if (isArdiaOwnFolder(made.realPath)) return failure("refused", "That folder holds Ardia's own data, so a plugin can't use it.");
    return grant(c, { exists: true, realPath: made.realPath, location: made.location, protected: false, device: made.device, inode: made.inode }, consent);
  });
  return outcome;
}

async function pick(c: Caller, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const prompt = params.prompt;
  if (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim() || prompt.length > PROMPT_MAX || /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(prompt)))
    return failure("bad_request", `prompt is the button's title, 1 to ${PROMPT_MAX} characters on one line.`);
  return asked(c, async (): Promise<Body> => {
    const start = sharedFoldersAvailable() ? sharedLocation().path : null;
    const picked = await pickFolder(start, (prompt as string | undefined) ?? "Choose");
    if (!picked) return { result: { folder: null } };
    if (!stillAllowed(c)) return failure("refused", "The plugin stopped or lost the folders permission while you were choosing.");
    const info = await folderInfo(picked);
    if (!info.exists) return failure("unavailable", "That folder can't be found.");
    if (isProtected(info) || isArdiaOwnFolder(picked)) return failure("refused", "That folder holds Ardia's own data or your whole home or Library, so a plugin can't use it.");
    return grant(c, info, consent);
  });
}

async function share(c: Caller, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const id = params.id;
  if (!isGrantId(id)) return failure("bad_request", "share needs a folder's id from ardia.folders.");
  const g = grantsOf(c.name)[id];
  if (!g || !Object.hasOwn(grantsOf(c.name), id)) return failure("refused", "That folder isn't one you let this plugin use.");
  const windowId = lastFocusedEligibleWindow(useBrowser.getState());
  if (!windowId) return { result: { ok: false } };
  const info = await folderInfo(g.path);
  if (!isGrantedFolder(g, info)) return { result: { ok: false } };
  if (!stillAllowed(c) || grantsOf(c.name)[id]?.path !== g.path) return failure("refused", "The plugin stopped, or the folder was forgotten, before it could be shared.");
  const url = fileUrlOf(g.path);
  try {
    await sharePage(cleanUrl(url), cleanLinkTitle(g.name, url) || null, windowId, null);
  } catch (error) {
    return failure("failed", errorText(error));
  }
  notePlugin("plugin_folder_shares", consent);
  return { result: { ok: true } };
}

function forget(c: Caller, params: Record<string, unknown>, consent: ConsentToken | null): Body {
  const id = params.id;
  if (!isGrantId(id)) return failure("bad_request", "forget needs a folder's id from ardia.folders.");
  if (!Object.hasOwn(grantsOf(c.name), id)) return { result: { ok: true } };
  dropFileWatches(c.name, id);
  filesRevoke(c.name, grantsOf(c.name)[id]!.path);
  const saved = updateRecord(
    c.name,
    (r) => {
      if (!r.folders || !Object.hasOwn(r.folders, id)) return r === NO_RECORD ? null : r;
      const { [id]: _gone, ...rest } = r.folders;
      const { folders: _all, ...without } = r;
      return Object.keys(rest).length ? { ...r, folders: rest } : without;
    },
    consent,
  );
  return saved ? { result: { ok: true } } : failure("failed", "plugins.json couldn't be saved, so the folder is still listed.");
}

export function foldersMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  if (!m.permissions.folders) return failure("refused", `${method} needs the folders permission.`);
  const consent = consentToken();
  switch (method) {
    case "folders.list":
      return list(c);
    case "folders.create":
      return create(c, m, params, consent);
    case "folders.pick":
      return pick(c, params, consent);
    case "folders.share":
      return share(c, params, consent);
    default:
      return forget(c, params, consent);
  }
}
