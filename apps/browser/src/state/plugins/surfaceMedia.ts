import { allowedHostsOf } from "../../lib/pluginPermissions";
import { matchesAllowedHost } from "../../lib/pluginNetwork";
import { urlParts } from "../../lib/urlParts";
import { finishPluginFile, loadPluginImage, openDroppedPluginFiles, pickPluginFiles, readPluginAssetImage, type PluginPickResult } from "../../platform/plugins";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { pluginReadyRun } from "./activation";
import { pickedFilesOf } from "./fileApis";
import { activeManifest, currentPlugins } from "./store";
import { manifestInProfile, windowProfileId } from "./profileScope";
import { mountedEntry } from "./surfaces";

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const ASSET_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,256}\.(png|jpe?g|gif|webp)$/i;
const MAX_DATA_URL = 512 * 1024;
const MAX_CACHED = 64;
const IMAGE_TIMEOUT_MS = 15_000;

const images = new Map<string, Promise<string | null>>();

export function pluginImageRequest(plugin: string, src: unknown): { kind: "data" | "remote" | "asset"; value: string } | null {
  if (typeof src !== "string" || !src) return null;
  if (src.length <= MAX_DATA_URL && DATA_IMAGE.test(src)) return { kind: "data", value: src };
  const m = activeManifest(currentPlugins(), plugin);
  if (!m) return null;
  if (ASSET_PATH.test(src)) return { kind: "asset", value: src };
  const parts = urlParts(src);
  if (parts?.scheme !== "https" || !parts.host) return null;
  return matchesAllowedHost(parts.host, allowedHostsOf(m.permissions)) ? { kind: "remote", value: src } : null;
}

export function pluginImage(plugin: string, src: unknown): Promise<string | null> {
  const request = pluginImageRequest(plugin, src);
  if (!request) return Promise.resolve(null);
  if (request.kind === "data") return Promise.resolve(request.value);
  const s = currentPlugins();
  const listing = s.listings[plugin];
  const m = activeManifest(s, plugin);
  const approved = s.records[plugin]?.approved;
  if (!m || (request.kind === "asset" && (!listing?.folderId || !approved))) return Promise.resolve(null);
  const key = `${plugin}@${listing?.hash ?? ""}:${request.value}`;
  const cached = images.get(key);
  if (cached) return cached;
  const loaded = (request.kind === "asset" ? readPluginAssetImage(plugin, listing!.folderId, approved!, request.value) : loadPluginImage({ url: request.value, timeoutMs: IMAGE_TIMEOUT_MS, allowedHosts: allowedHostsOf(m.permissions) }))
    .then((r) => (r.ok && r.url.startsWith("data:image/") ? r.url : null))
    .catch(() => null);
  if (images.size >= MAX_CACHED) images.delete(images.keys().next().value!);
  images.set(key, loaded);
  void loaded.then((url) => {
    if (url === null && images.get(key) === loaded) images.delete(key);
  });
  return loaded;
}

export const forgetPluginImages = (plugin: string) => {
  for (const key of [...images.keys()]) if (key.startsWith(`${plugin}@`)) images.delete(key);
};

type ViewFiles = { accept: string[]; multiple: boolean; maxBytes: number | null };
type Picked = { name: string; mimeType: string; handle?: string };

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function acceptsFile(accept: readonly string[], file: { name: string; mimeType?: string }): boolean {
  if (!accept.length) return true;
  const ext = extensionOf(file.name);
  const mime = (file.mimeType ?? "").toLowerCase();
  return accept.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.includes("/")) return entry.endsWith("/*") ? !!mime && mime.startsWith(entry.slice(0, -1)) : mime === entry;
    return ext !== "" && ext === entry.replace(/^\./, "");
  });
}

export const droppedFilePaths = (items: readonly { kind: string; url?: string }[]) =>
  items.flatMap((item) => {
    if (item.kind !== "file" || typeof item.url !== "string" || !item.url.startsWith("file://")) return [];
    try {
      return [decodeURIComponent(new URL(item.url).pathname)];
    } catch {
      return [];
    }
  });

const extensionsOnly = (accept: readonly string[]) => accept.every((a) => !a.includes("/"));

function closeHandles(plugin: string, run: number, files: readonly Picked[]) {
  for (const f of files) if (f.handle) void finishPluginFile(plugin, run, f.handle, false).catch(() => undefined);
}

async function filesForView(plugin: string, surfaceId: string, windowId: string, options: ViewFiles, open: (name: string, run: number) => Promise<PluginPickResult>) {
  const m = activeManifest(currentPlugins(), plugin);
  const run = pluginReadyRun(plugin);
  const instance = mountedEntry(plugin, surfaceId);
  const profileId = windowProfileId(windowId);
  if (m?.permissions.files !== "picker" || run === null || !instance || instance.windowId !== windowId || !manifestInProfile(currentPlugins(), plugin, profileId)) return null;
  const consent = consentToken();
  const picked = await open(plugin, run).catch(() => null);
  const still =
    activeManifest(currentPlugins(), plugin)?.permissions.files === "picker" &&
    pluginReadyRun(plugin) === run &&
    mountedEntry(plugin, surfaceId) === instance &&
    instance.windowId === windowId &&
    windowProfileId(windowId) === profileId &&
    !!manifestInProfile(currentPlugins(), plugin, profileId);
  if (!picked?.ok) return null;
  if (!still) {
    closeHandles(plugin, run, picked.files);
    return null;
  }
  const kept = picked.files.filter((f) => acceptsFile(options.accept, f)).slice(0, options.multiple ? picked.files.length : 1);
  closeHandles(plugin, run, picked.files.filter((f) => !kept.includes(f)));
  if (!kept.length) return null;
  notePlugin("plugin_file_picks", consent);
  return pickedFilesOf(kept);
}

export const pickFilesForPluginView = (plugin: string, surfaceId: string, windowId: string, options: ViewFiles) =>
  filesForView(plugin, surfaceId, windowId, options, (name, run) => pickPluginFiles({ name, run, multiple: options.multiple, types: options.accept.slice(0, 32), ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}) }));

export function dropFilesOnPluginView(plugin: string, surfaceId: string, windowId: string, paths: string[], options: ViewFiles) {
  const byName = extensionsOnly(options.accept);
  const wanted = (byName ? paths.filter((path) => acceptsFile(options.accept, { name: path.slice(path.lastIndexOf("/") + 1) })) : paths).slice(0, options.multiple || !byName ? 16 : 1);
  if (!wanted.length) return Promise.resolve(null);
  return filesForView(plugin, surfaceId, windowId, options, (name, run) => openDroppedPluginFiles({ name, run, paths: wanted, ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}) }));
}

export const pluginCanPickFiles = (plugin: string) => activeManifest(currentPlugins(), plugin)?.permissions.files === "picker";
