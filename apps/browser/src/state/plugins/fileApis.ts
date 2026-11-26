import type { PluginManifest } from "../../lib/pluginManifest";
import { beginPluginSave, finishPluginFile, pickPluginFiles, readPluginFileChunk, savePluginChunk, type PluginPickedFile } from "../../platform/plugins";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { needsGesture } from "./osApis";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";

type Caller = { name: string; run: number };

export const FILE_LIMITS = { files: 16, fileBytes: 64 * 1024 * 1024, chunkBytes: 512 * 1024, chunkText: 700 * 1024, types: 32 } as const;
const HANDLE = /^h\d{1,12}$/;

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.slice(0, max) : undefined);
const stillAllowed = (c: Caller) => acceptsRun(c.name, c.run) && activeManifest(currentPlugins(), c.name)?.permissions.files === "picker";
const ended = (): Body => failure("refused", "The plugin stopped or lost files: picker before the files were handed over.");

export const pickedFilesOf = (files: PluginPickedFile[]) =>
  files.slice(0, FILE_LIMITS.files).map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType, data: f.data, encoding: f.encoding, ...(f.handle ? { handle: f.handle } : {}) }));

export async function filesMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> {
  if (m.permissions.files !== "picker") return failure("refused", `${method} needs files: picker.`);
  const consent = consentToken();
  const handle = typeof params.handle === "string" && HANDLE.test(params.handle) ? params.handle : null;
  if (method === "fs.readChunk") {
    if (!handle) return failure("bad_request", "fs.readChunk needs a handle.");
    const offset = typeof params.offset === "number" && Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    const length = typeof params.length === "number" && Number.isSafeInteger(params.length) && params.length > 0 ? Math.min(params.length, FILE_LIMITS.chunkBytes) : FILE_LIMITS.chunkBytes;
    const chunk = await readPluginFileChunk(c.name, c.run, handle, offset, length).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    return chunk.ok ? { result: { data: chunk.data, eof: chunk.eof } } : failure("failed", chunk.reason);
  }
  if (method === "fs.closeFile" || method === "fs.saveCommit") {
    if (!handle) return failure("bad_request", `${method} needs a handle.`);
    const commit = method === "fs.saveCommit" && params.commit !== false;
    const done = await finishPluginFile(c.name, c.run, handle, commit).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    if (!done.ok) return failure("failed", done.reason);
    if (commit && done.saved) notePlugin("plugin_file_saves", consent);
    return { result: { saved: done.saved, ...(done.name ? { name: done.name } : {}) } };
  }
  if (method === "fs.saveChunk") {
    if (!handle || typeof params.data !== "string" || params.data.length > FILE_LIMITS.chunkText || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data)) return failure("bad_request", "fs.saveChunk needs a handle and up to 700 KB of base64.");
    const wrote = await savePluginChunk(c.name, c.run, handle, params.data).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    return wrote.ok ? { result: { ok: true } } : failure("failed", wrote.reason);
  }
  const gesture = needsGesture(c, method);
  if (gesture) return gesture;
  if (method === "fs.pickFiles") {
    const types = Array.isArray(params.types) ? params.types.filter((t): t is string => typeof t === "string" && t.length <= 100).slice(0, FILE_LIMITS.types) : [];
    const title = text(params.title, 120);
    const picked = await pickPluginFiles({ name: c.name, run: c.run, multiple: params.multiple === true, types, ...(title ? { title } : {}) }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    if (!stillAllowed(c)) {
      if (picked.ok) for (const f of picked.files) if (f.handle) void finishPluginFile(c.name, c.run, f.handle, false).catch(() => undefined);
      return ended();
    }
    if (!picked.ok) return "cancelled" in picked && picked.cancelled ? { result: { files: [] } } : failure("failed", picked.reason);
    notePlugin("plugin_file_picks", consent);
    return { result: { files: pickedFilesOf(picked.files) } };
  }
  const fileName = text(params.name, 200);
  if (!fileName) return failure("bad_request", `${method} needs a name.`);
  const begun = await beginPluginSave({ name: c.name, run: c.run, fileName }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!begun.ok) return failure("failed", begun.reason);
  if (!stillAllowed(c)) {
    if (begun.handle) void finishPluginFile(c.name, c.run, begun.handle, false).catch(() => undefined);
    return ended();
  }
  return { result: { saved: begun.saved, ...(begun.handle ? { handle: begun.handle } : {}), ...(begun.name ? { name: begun.name } : {}) } };
}
