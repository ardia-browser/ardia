import { bytesEqual, concatBytes, hex } from "../shared/bytes";
import { errorCode, type FileStore } from "./files";
import { Sha256 } from "./sha256";

const POINTER_MAGIC = new Uint8Array([0x00, 0x4e, 0x42, 0x4c, 0x4f, 0x42, 0x31, 0x0a]);
const POINTER_MAX = 256 * 1024;

export type BlobPointer = { v: 1; size: number; sha: string; chunks: { sha: string; size: number }[]; dir: string };

export type BlobRead = { found: false } | { found: true; data: Uint8Array; size: number; mtimeMs: number; pointer: BlobPointer | null } | { found: true; tooLarge: true; size: number; mtimeMs: number };

export const sha256Hex = (data: Uint8Array) => hex(new Sha256().update(data).digest());

function encodePointer(pointer: BlobPointer): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(pointer));
  return concatBytes([POINTER_MAGIC, body]);
}

function decodePointer(data: Uint8Array): BlobPointer | null | "invalid" {
  if (data.length < POINTER_MAGIC.length || !bytesEqual(data.subarray(0, POINTER_MAGIC.length), POINTER_MAGIC)) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(data.subarray(POINTER_MAGIC.length))) as BlobPointer;
    if (v.v !== 1 || typeof v.size !== "number" || typeof v.sha !== "string" || typeof v.dir !== "string" || !Array.isArray(v.chunks)) return "invalid";
    if (!/^[A-Za-z0-9._/-]{1,512}$/.test(v.dir) || v.dir.split("/").some((p) => p === ".." || p === "")) return "invalid";
    if (v.chunks.length > 100_000 || v.chunks.some((c) => typeof c?.sha !== "string" || !/^[0-9a-f]{64}$/.test(c.sha) || !Number.isInteger(c.size) || c.size < 0)) return "invalid";
    if (v.chunks.reduce((n, c) => n + c.size, 0) !== v.size) return "invalid";
    return v;
  } catch {
    return "invalid";
  }
}

export function isPointer(data: Uint8Array): boolean {
  return data.length >= POINTER_MAGIC.length && bytesEqual(data.subarray(0, POINTER_MAGIC.length), POINTER_MAGIC);
}

async function writeChunk(fs: FileStore, path: string, piece: Uint8Array): Promise<void> {
  try {
    const wrote = await fs.write(path, piece, { exclusive: true });
    if (wrote.size === piece.length) return;
  } catch (error) {
    if (errorCode(error) !== "exists") throw error;
  }
  const back = await fs.read(path, { length: piece.length + 1 });
  if (!back.found || back.size !== piece.length || !bytesEqual(back.data, piece)) {
    if (back.found) await fs.remove(path).catch(() => false);
    throw Object.assign(new Error(`The piece ${path} didn't write correctly.`), { code: "unavailable" });
  }
}

export async function writeBlob(fs: FileStore, path: string, data: Uint8Array, options: { chunkDir: string; exclusive?: boolean }): Promise<{ pointer: BlobPointer | null; size: number; mtimeMs: number }> {
  if (data.length <= fs.maxWrite && !isPointer(data)) {
    const res = await fs.write(path, data, options.exclusive ? { exclusive: true } : {});
    return { pointer: null, ...res };
  }
  const step = Math.max(1, fs.maxWrite);
  const chunks: { sha: string; size: number }[] = [];
  for (let at = 0; at < data.length; at += step) {
    const piece = data.subarray(at, at + step);
    const sha = sha256Hex(piece);
    await writeChunk(fs, `${options.chunkDir}/${sha}`, piece);
    chunks.push({ sha, size: piece.length });
  }
  const pointer: BlobPointer = { v: 1, size: data.length, sha: sha256Hex(data), chunks, dir: options.chunkDir };
  const body = encodePointer(pointer);
  if (body.length > Math.min(POINTER_MAX, fs.maxWrite)) throw Object.assign(new Error(`${path} is too big to describe.`), { code: "too_large" });
  const res = await fs.write(path, body, options.exclusive ? { exclusive: true } : {});
  return { pointer, ...res };
}

export async function blobMatches(fs: FileStore, path: string, sha: string, size: number): Promise<boolean> {
  const head = await fs.read(path, { length: 0 });
  if (!head.found) return false;
  if (size <= fs.maxWrite && head.size === size) return true;
  if (head.size > Math.min(POINTER_MAX, fs.maxWrite)) return false;
  const res = await fs.read(path, { length: head.size + 1 });
  if (!res.found) return false;
  const pointer = decodePointer(res.data);
  if (!pointer || pointer === "invalid" || pointer.sha !== sha || pointer.size !== size) return false;
  for (const chunk of pointer.chunks) {
    const piece = await fs.read(`${pointer.dir}/${chunk.sha}`, { length: 0 });
    if (!piece.found || piece.size !== chunk.size) return false;
  }
  return true;
}

export async function readBlob(fs: FileStore, path: string, options: { maxBytes: number }): Promise<BlobRead> {
  const limit = Math.min(fs.maxWrite, Math.max(options.maxBytes, POINTER_MAX));
  const res = await fs.read(path, { length: limit + 1 });
  if (!res.found) return { found: false };
  if (res.size > limit) return { found: true, tooLarge: true, size: res.size, mtimeMs: res.mtimeMs };
  const pointer = decodePointer(res.data);
  if (pointer === "invalid") throw Object.assign(new Error(`${path} names its pieces wrongly.`), { code: "damaged" });
  if (!pointer) {
    if (res.size > options.maxBytes) return { found: true, tooLarge: true, size: res.size, mtimeMs: res.mtimeMs };
    return { found: true, data: res.data, size: res.size, mtimeMs: res.mtimeMs, pointer: null };
  }
  if (pointer.size > options.maxBytes) return { found: true, tooLarge: true, size: pointer.size, mtimeMs: res.mtimeMs };
  const parts: Uint8Array[] = [];
  for (const chunk of pointer.chunks) {
    const piece = await fs.read(`${pointer.dir}/${chunk.sha}`, { length: chunk.size + 1 });
    if (!piece.found || piece.size !== chunk.size || sha256Hex(piece.data) !== chunk.sha) throw Object.assign(new Error(`A piece of ${path} is missing or damaged.`), { code: "damaged" });
    parts.push(piece.data);
  }
  const data = concatBytes(parts);
  if (sha256Hex(data) !== pointer.sha) throw Object.assign(new Error(`${path} doesn't match its checksum.`), { code: "damaged" });
  return { found: true, data, size: data.length, mtimeMs: res.mtimeMs, pointer };
}

export async function removeUnreferencedChunks(fs: FileStore, chunkDir: string, keep: BlobPointer | null): Promise<void> {
  const wanted = new Set((keep?.chunks ?? []).map((c) => c.sha));
  for (const e of await fs.list(chunkDir).catch(() => [])) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1);
    if (e.kind === "file" && !wanted.has(name)) await fs.remove(`${chunkDir}/${name}`).catch(() => false);
  }
}
