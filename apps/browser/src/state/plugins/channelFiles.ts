import { filesCall, filesRevoke, filesTicket, filesUnwatch, filesWatch, onPluginFilesChange, pluginFolderInfo, sendToPlugin, type PluginFilesResult, type PluginFilesSpec, type PluginFolderIdentity } from "../../platform/plugins";
import { errorText } from "../../lib/errors";
import { pickFiles } from "../../platform/dialogs";
import { useBrowser } from "../browser/store";
import { lastFocusedEligibleWindow } from "../automation/automationWindows";
import { isArdiaOwnFolder } from "./channelFolders";
import { secureRandomHex } from "../../platform/secureRandom";
import type { PluginManifest } from "../../lib/pluginManifest";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { notePlugin, notePluginTimes } from "../telemetry/pluginCounts";
import { grantIdentity, isGrantId } from "./folderGrants";
import { updateRecord } from "./lifecycle";
import { acceptsRun, onProcessStopped } from "./process";
import { activeManifest, currentPlugins, recordOf } from "./store";

export const FILES_LIMITS = { callBytes: 4 * 1024 * 1024, pathBytes: 1024, segmentBytes: 255, watchesPerRun: 8, eventPaths: 1000, picksPerCall: 64, picksKept: 64 } as const;

export const FILES_METHODS = ["files.read", "files.write", "files.append", "files.list", "files.remove", "files.watch", "files.unwatch", "files.pick"] as const;

const ERROR_CODES = ["not_found", "exists", "too_large", "bad_path", "refused", "unavailable"] as const;
const REFUSAL_CODES = new Set<string>(["bad_path", "refused", "too_large"]);
const MAX_BASE64_LENGTH = Math.ceil(FILES_LIMITS.callBytes / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩﻿]/;
const ARDIA_TEMP_NAME = /^\..+\.ardia-/;

type Caller = { name: string; run: number };
type RootRef = { path: string | null; label: string; identity: PluginFolderIdentity | null; ticket: number; onlyFile?: string; fileIdentity?: PluginFolderIdentity };
type PickedFile = { name: string; run: number; dir: string; identity: PluginFolderIdentity; file: string; fileIdentity: PluginFolderIdentity };

const PICK_ID = /^p[0-9a-f]{10}$/;
const picked = new Map<string, Map<string, PickedFile>>();
const picking = new Set<string>();

export const isPickId = (value: unknown): value is string => typeof value === "string" && PICK_ID.test(value);

export function dropPickedFiles(name: string) {
  picked.delete(name);
}

export const pickedFileCount = (name: string) => picked.get(name)?.size ?? 0;
type Root = ({ ok: true } & RootRef) | { ok: false; body: Body };
type FilesWatch = { name: string; run: number; label: string; grant: string | null };

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

export function pathProblem(value: unknown, allowRoot = false): string | null {
  if (typeof value !== "string") return "path is text, like notes/today.md.";
  if (value === "") return allowRoot ? null : "path can't be empty.";
  if (!wellFormed(value) || UNSAFE_CHARACTER.test(value)) return "path can't hold control or direction characters.";
  if (value.startsWith("/")) return "path is relative to the root, without a leading /.";
  if (utf8Length(value) > FILES_LIMITS.pathBytes) return `path is at most ${FILES_LIMITS.pathBytes} bytes.`;
  for (const segment of value.split("/")) {
    if (!segment) return "path can't have empty parts (// or a trailing /).";
    if (segment === "." || segment === "..") return "path can't hold . or .. parts.";
    if (utf8Length(segment) > FILES_LIMITS.segmentBytes) return `each part of path is at most ${FILES_LIMITS.segmentBytes} bytes.`;
    if (ARDIA_TEMP_NAME.test(segment)) return "path can't use the names Ardia gives its temporary files.";
  }
  return null;
}

export function base64Problem(value: unknown): string | null {
  if (typeof value !== "string") return "data is base64 text.";
  if (value.length > MAX_BASE64_LENGTH) return `data is over ${FILES_LIMITS.callBytes / 1024 / 1024} MB; split it into appends.`;
  return value.length % 4 === 0 && BASE64.test(value) ? null : "data isn't base64 (A–Z, a–z, 0–9, + and /, padded with =).";
}

const decodedLength = (base64: string) => (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const grantOf = (name: string, id: string) => {
  const folders = recordOf(currentPlugins(), name).folders;
  return folders && Object.hasOwn(folders, id) ? folders[id]! : null;
};

export function rootFor(c: Caller, m: PluginManifest, raw: unknown): Root {
  if (!m.permissions.files) return { ok: false, body: failure("refused", "files needs the files permission.") };
  if (raw === undefined || raw === null || raw === "data") return { ok: true, path: null, label: "data", identity: null, ticket: filesTicket() };
  if (typeof raw !== "string") return { ok: false, body: failure("bad_request", "root is \"data\" or a folder's id from ardia.folders.") };
  if (isPickId(raw)) {
    const pick = picked.get(c.name)?.get(raw);
    if (!pick || pick.run !== c.run) return { ok: false, body: failure("refused", "That file isn't one you picked for this plugin, or the plugin restarted since.") };
    return { ok: true, path: pick.dir, label: raw, identity: pick.identity, ticket: filesTicket(), onlyFile: pick.file, fileIdentity: pick.fileIdentity };
  }
  if (!m.permissions.folders) return { ok: false, body: failure("refused", "A folder root needs the folders permission.") };
  const grant = isGrantId(raw) ? grantOf(c.name, raw) : null;
  if (!grant) return { ok: false, body: failure("refused", "That folder isn't one you let this plugin use.") };
  return { ok: true, path: grant.path, label: raw, identity: grantIdentity(grant), ticket: filesTicket() };
}

const isIdentityPart = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function learnedIdentity(name: string, id: string, path: string): Promise<PluginFolderIdentity | null> {
  const info = await pluginFolderInfo(path).catch(() => null);
  if (!info?.exists || info.realPath !== path || !isIdentityPart(info.device) || !isIdentityPart(info.inode)) return null;
  const identity = { device: info.device, inode: info.inode };
  updateRecord(
    name,
    (r) => {
      const grant = r.folders && Object.hasOwn(r.folders, id) ? r.folders[id]! : null;
      return grant && grant.path === path && !grantIdentity(grant) ? { ...r, folders: { ...r.folders, [id]: { ...grant, ...identity } } } : r;
    },
    null,
  );
  return identity;
}

const rootSpec = (root: RootRef) => ({ root: root.path, ticket: root.ticket, ...(root.identity ? { rootIdentity: root.identity } : {}), ...(root.fileIdentity ? { fileIdentity: root.fileIdentity } : {}) });

function refusalCounted(body: Body, consent: ConsentToken | null): Body {
  const code = "error" in body && typeof body.error === "object" && body.error !== null ? (body.error as { code?: unknown }).code : null;
  if (typeof code === "string" && REFUSAL_CODES.has(code)) notePlugin("plugin_file_refusals", consent);
  return body;
}

type NativeOutcome = { ok: true; value: Extract<PluginFilesResult, { ok: true }> } | { ok: false; body: Body };

async function nativeCall(spec: PluginFilesSpec): Promise<NativeOutcome> {
  let answered: PluginFilesResult;
  try {
    answered = await filesCall(spec);
  } catch (error) {
    return { ok: false, body: failure("failed", errorText(error)) };
  }
  if (!answered || typeof answered !== "object") return { ok: false, body: failure("failed", "Ardia's file service didn't answer.") };
  if (answered.ok) return { ok: true, value: answered };
  const code = (ERROR_CODES as readonly string[]).includes(answered.code) ? answered.code : "failed";
  return { ok: false, body: failure(code, typeof answered.message === "string" && answered.message ? answered.message : "The file couldn't be used.") };
}

const sizeAndTime = (value: { size?: number; mtimeMs?: number }) => ({ size: isCount(value.size) ? value.size : 0, mtimeMs: typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) ? value.mtimeMs : 0 });

async function read(c: Caller, root: RootRef, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const problem = pathProblem(params.path);
  if (problem) return failure("bad_path", problem);
  const { offset, length } = params;
  if (offset !== undefined && !isCount(offset)) return failure("bad_request", "offset is a whole number, 0 or more.");
  if (length !== undefined && !isCount(length)) return failure("bad_request", "length is a whole number, 0 or more.");
  if (isCount(length) && length > FILES_LIMITS.callBytes) return failure("too_large", `length is at most ${FILES_LIMITS.callBytes} bytes.`);
  const windowed = offset !== undefined || length !== undefined;
  const window = windowed ? { offset: offset ?? 0, length: length ?? FILES_LIMITS.callBytes } : {};
  const outcome = await nativeCall({ op: "read", plugin: c.name, ...rootSpec(root), path: params.path as string, ...window });
  if (!outcome.ok) return outcome.body;
  if (outcome.value.found === false) return { result: { found: false } };
  notePlugin("plugin_file_reads", consent);
  return { result: { found: true, data: typeof outcome.value.data === "string" ? outcome.value.data : "", ...sizeAndTime(outcome.value) } };
}

async function write(c: Caller, root: RootRef, params: Record<string, unknown>, op: "write" | "append", consent: ConsentToken | null): Promise<Body> {
  const problem = pathProblem(params.path);
  if (problem) return failure("bad_path", problem);
  const dataProblem = base64Problem(params.data);
  if (dataProblem) return failure(typeof params.data === "string" && params.data.length > MAX_BASE64_LENGTH ? "too_large" : "bad_request", dataProblem);
  if (decodedLength(params.data as string) > FILES_LIMITS.callBytes) return failure("too_large", `data is over ${FILES_LIMITS.callBytes / 1024 / 1024} MB; split it into appends.`);
  if (params.exclusive !== undefined && typeof params.exclusive !== "boolean") return failure("bad_request", "exclusive is true or false.");
  if (op === "append" && params.exclusive !== undefined) return failure("bad_request", "append has no exclusive.");
  const outcome = await nativeCall({ op, plugin: c.name, ...rootSpec(root), path: params.path as string, data: params.data as string, ...(params.exclusive === true ? { exclusive: true } : {}) });
  if (!outcome.ok) return outcome.body;
  notePlugin("plugin_file_writes", consent);
  return { result: sizeAndTime(outcome.value) };
}

async function list(c: Caller, root: RootRef, params: Record<string, unknown>): Promise<Body> {
  const dir = params.dir ?? "";
  const problem = pathProblem(dir, true);
  if (problem) return failure("bad_path", problem.replace(/^path/, "dir"));
  if (params.recursive !== undefined && typeof params.recursive !== "boolean") return failure("bad_request", "recursive is true or false.");
  const outcome = await nativeCall({ op: "list", plugin: c.name, ...rootSpec(root), path: dir as string, ...(params.recursive === true ? { recursive: true } : {}) });
  if (!outcome.ok) return outcome.body;
  return { result: { entries: Array.isArray(outcome.value.entries) ? outcome.value.entries : [] } };
}

async function remove(c: Caller, root: RootRef, params: Record<string, unknown>): Promise<Body> {
  const problem = pathProblem(params.path);
  if (problem) return failure("bad_path", problem);
  const outcome = await nativeCall({ op: "remove", plugin: c.name, ...rootSpec(root), path: params.path as string });
  if (!outcome.ok) return outcome.body;
  return { result: { removed: outcome.value.removed === true } };
}

const watches = new Map<string, FilesWatch>();

const randomWatchId = () => `w${secureRandomHex(16)}`;

function dropWatch(id: string) {
  if (!watches.delete(id)) return;
  filesUnwatch(id);
}

const watchLive = (w: FilesWatch): boolean => {
  if (!acceptsRun(w.name, w.run)) return false;
  const m = activeManifest(currentPlugins(), w.name);
  if (!m?.permissions.files) return false;
  return w.grant === null || (m.permissions.folders && !!grantOf(w.name, w.grant));
};

export function dropFileWatches(name: string, grant?: string) {
  for (const [id, w] of [...watches]) if (w.name === name && (grant === undefined || w.grant === grant)) dropWatch(id);
}

export const fileWatchCount = (name: string) => [...watches.values()].filter((w) => w.name === name).length;

function watch(c: Caller, root: RootRef): Body {
  const mine = [...watches.values()].filter((w) => w.name === c.name && w.run === c.run).length;
  if (mine >= FILES_LIMITS.watchesPerRun) return failure("refused", `A plugin keeps at most ${FILES_LIMITS.watchesPerRun} watches at a time; dispose one first.`);
  const id = randomWatchId();
  let started = false;
  try {
    started = filesWatch(id, c.name, root.path, root.identity) === true;
  } catch (error) {
    return failure("failed", errorText(error));
  }
  if (!started) return failure("unavailable", "That folder can't be watched now.");
  watches.set(id, { name: c.name, run: c.run, label: root.label, grant: root.path === null ? null : root.label });
  return { result: { watch: id } };
}

function unwatch(c: Caller, params: Record<string, unknown>): Body {
  const id = params.watch;
  if (typeof id !== "string") return failure("bad_request", "unwatch needs the watch id files.watch answered.");
  const w = watches.get(id);
  if (w && w.name === c.name) dropWatch(id);
  return { result: { ok: true } };
}

function deliverChange(change: { id: string; paths: string[]; gone?: boolean }) {
  const w = watches.get(change.id);
  if (!w) return;
  if (!watchLive(w)) return dropWatch(change.id);
  if (change.gone === true) {
    watches.delete(change.id);
    sendToPlugin(w.name, w.run, JSON.stringify({ event: "files.changed", time: Date.now(), data: { watch: change.id, root: w.label, paths: [], gone: true } }));
    return;
  }
  const paths = (Array.isArray(change.paths) ? change.paths : []).filter((p): p is string => typeof p === "string" && pathProblem(p) === null);
  if (!paths.length) return;
  for (let at = 0; at < paths.length; at += FILES_LIMITS.eventPaths)
    sendToPlugin(w.name, w.run, JSON.stringify({ event: "files.changed", time: Date.now(), data: { watch: change.id, root: w.label, paths: paths.slice(at, at + FILES_LIMITS.eventPaths) } }));
}

let listening = false;

export function startFileWatches() {
  if (listening) return;
  listening = true;
  onPluginFilesChange(deliverChange);
  onProcessStopped((name) => {
    dropFileWatches(name);
    dropPickedFiles(name);
    filesRevoke(name, null);
  });
}

const FILE_URL = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i;

const fileUrlPath = (url: string): string | null => {
  if (url.startsWith("/")) return url;
  const m = FILE_URL.exec(url);
  if (!m) return null;
  try {
    const path = decodeURIComponent(m[1]!);
    return path.includes("\u0000") ? null : path;
  } catch {
    return null;
  }
};

async function pickedEntry(c: Caller, path: string): Promise<{ id: string; name: string; size: number } | null> {
  const cut = path.lastIndexOf("/");
  const dir = path.slice(0, cut) || "/";
  const file = path.slice(cut + 1);
  if (!file || pathProblem(file) !== null) return null;
  const info = await pluginFolderInfo(dir).catch(() => null);
  if (!info?.exists || info.protected === true || isArdiaOwnFolder(info.realPath) || isArdiaOwnFolder(path)) return null;
  if (!isIdentityPart(info.device) || !isIdentityPart(info.inode)) return null;
  const identity = { device: info.device, inode: info.inode };
  const probe = await nativeCall({ op: "read", plugin: c.name, root: info.realPath, ticket: filesTicket(), rootIdentity: identity, path: file, offset: 0, length: 0 });
  if (!probe.ok || probe.value.found === false) return null;
  const opened = probe.value as { device?: unknown; inode?: unknown };
  if (!isIdentityPart(opened.device) || !isIdentityPart(opened.inode)) return null;
  const fileIdentity = { device: opened.device, inode: opened.inode };
  let mine = picked.get(c.name);
  if (!mine) picked.set(c.name, (mine = new Map()));
  let id = `p${secureRandomHex(10)}`;
  while (mine.has(id)) id = `p${secureRandomHex(10)}`;
  mine.set(id, { name: c.name, run: c.run, dir: info.realPath, identity, file, fileIdentity });
  while (mine.size > FILES_LIMITS.picksKept) mine.delete(mine.keys().next().value!);
  return { id, name: file, size: sizeAndTime(probe.value).size };
}

async function pick(c: Caller, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  if (params.multiple !== undefined && typeof params.multiple !== "boolean") return failure("bad_request", "multiple is true or false.");
  if (picking.has(c.name)) return failure("failed", "This plugin is already asking for a file. Wait for that answer first.");
  if (!lastFocusedEligibleWindow(useBrowser.getState())) return failure("no_window", "No window to ask in.");
  picking.add(c.name);
  try {
    let urls: unknown;
    try {
      urls = await pickFiles();
    } catch (error) {
      return failure("failed", errorText(error));
    }
    const chosen = (Array.isArray(urls) ? urls : []).filter((u): u is string => typeof u === "string").slice(0, params.multiple === true ? FILES_LIMITS.picksPerCall : 1);
    if (!acceptsRun(c.name, c.run) || !activeManifest(currentPlugins(), c.name)?.permissions.files) return failure("refused", "The plugin stopped or lost the files permission while you were choosing.");
    const files: { id: string; name: string; size: number }[] = [];
    let refused = 0;
    for (const url of chosen) {
      const path = fileUrlPath(url);
      const entry = path ? await pickedEntry(c, path) : null;
      if (entry) files.push(entry);
      else refused++;
    }
    if (refused) notePlugin("plugin_file_refusals", consent);
    if (files.length) notePluginTimes("plugin_file_picks", files.length, consent);
    if (!files.length && chosen.length) return failure("refused", "That file can't be given to a plugin: it's a link, it sits in Ardia's own data or right in your home folder, or it went away.");
    return { result: { files } };
  } finally {
    picking.delete(c.name);
  }
}

export function filesMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  const consent = consentToken();
  if (method === "files.unwatch") return unwatch(c, params);
  if (method === "files.pick") return m.permissions.files ? pick(c, params, consent) : refusalCounted(failure("refused", "files.pick needs the files permission."), consent);
  const found = rootFor(c, m, params.root);
  if (!found.ok) return refusalCounted(found.body, consent);
  if (found.onlyFile !== undefined && (method !== "files.read" || params.path !== found.onlyFile)) return refusalCounted(failure("refused", "A picked file can only be read, by its own name."), consent);
  if (found.path !== null && found.identity === null) return routedOnceIdentified(c, method, params, found, consent);
  return routed(c, method, params, found, consent);
}

async function routedOnceIdentified(c: Caller, method: string, params: Record<string, unknown>, found: RootRef, consent: ConsentToken | null): Promise<Body> {
  const identity = await learnedIdentity(c.name, found.label, found.path!);
  if (!identity) return refusalCounted(failure("unavailable", "That folder can't be found where it was, so pick it again."), consent);
  const m = activeManifest(currentPlugins(), c.name);
  const again = m && acceptsRun(c.name, c.run) ? rootFor(c, m, params.root) : null;
  if (!again?.ok || again.path !== found.path) return refusalCounted(failure("refused", "The plugin stopped, or the folder was forgotten, while Ardia looked for it."), consent);
  return routed(c, method, params, { ...again, identity, ticket: found.ticket }, consent);
}

function routed(c: Caller, method: string, params: Record<string, unknown>, root: RootRef, consent: ConsentToken | null): Body | Promise<Body> {
  const answered = (body: Body | Promise<Body>) => (body instanceof Promise ? body.then((b) => refusalCounted(b, consent)) : refusalCounted(body, consent));
  switch (method) {
    case "files.read":
      return answered(read(c, root, params, consent));
    case "files.write":
      return answered(write(c, root, params, "write", consent));
    case "files.append":
      return answered(write(c, root, params, "append", consent));
    case "files.list":
      return answered(list(c, root, params));
    case "files.remove":
      return answered(remove(c, root, params));
    default:
      return answered(watch(c, root));
  }
}
