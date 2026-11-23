import { isFields } from "../../lib/decode";
import { hostFetchPlugin, readPluginFile, readPluginStorage, writePluginStorage, type PluginFetchResult, type PluginFetchSpec, type PluginFileReadResult } from "../../platform/plugins";

type HostFetchSpec = PluginFetchSpec;
type HostFetchResult = PluginFetchResult;
type HostFileResult = PluginFileReadResult;

export const hostFetch = (spec: HostFetchSpec): Promise<HostFetchResult> => hostFetchPlugin(spec).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));

type StorageRead = { status: "ok"; text: string } | { status: "missing" } | { status: "error"; reason: string };

export function storageReadOf(raw: unknown): StorageRead {
  if (raw === null || raw === undefined) return { status: "missing" };
  if (typeof raw === "string") return { status: "ok", text: raw };
  if (isFields(raw)) {
    if (raw.status === "missing") return { status: "missing" };
    if (raw.status === "ok" && typeof raw.text === "string") return { status: "ok", text: raw.text };
    if (raw.status === "error") return { status: "error", reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "The plugin's storage couldn't be read." };
  }
  return { status: "error", reason: "The plugin's storage couldn't be read." };
}

export const readStorageText = (name: string): Promise<StorageRead> =>
  Promise.resolve()
    .then(() => readPluginStorage(name) as Promise<unknown>)
    .then(storageReadOf, (error: unknown): StorageRead => ({ status: "error", reason: String(error) }));

export const writeStorageText = (name: string, text: string): Promise<{ ok: boolean; reason?: string }> => writePluginStorage(name, text).catch((error: unknown) => ({ ok: false, reason: String(error) }));

export const readFolderFile = (name: string, folderId: string, approved: string, path: string): Promise<HostFileResult> =>
  readPluginFile(name, folderId, approved, path).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
