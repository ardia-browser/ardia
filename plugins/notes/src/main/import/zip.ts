import { Inflate, inflateSync } from "fflate";
import { crc32 } from "../../shared/bytes";
import { ImportError } from "./limits";

export type RandomAccess = { size: number; read(offset: number, length: number): Promise<Uint8Array> };

export type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number; crc: number };

export const ZIP_LIMITS = {
  entries: 100_000,
  totalBytes: 8 * 1024 * 1024 * 1024,
  ratio: 1000,
  ratioFloor: 16 * 1024 * 1024,
  directoryBytes: 64 * 1024 * 1024,
};

const INFLATE_INPUT = 16 * 1024;

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 0x1_0000_0000;

const latin = (bytes: Uint8Array) => {
  const cp437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : cp437[b - 0x80];
  return out;
};

export function cleanEntryName(raw: string): string | null {
  if (!raw || raw.includes("\u0000")) return null;
  const name = raw.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (!parts.length) return null;
  return parts.join("/") + (name.endsWith("/") ? "/" : "");
}

export class ZipReader {
  private constructor(readonly entries: ZipEntry[], readonly refused: number, private readonly source: RandomAccess) {}

  static async open(source: RandomAccess): Promise<ZipReader> {
    if (source.size < 22) throw new ImportError("That file isn't a zip archive.");
    const tailLength = Math.min(source.size, 22 + 65_535 + 20);
    const tail = await source.read(source.size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
    if (eocd < 0) throw new ImportError("That file isn't a zip archive, or it's cut short.");
    let count = u16(tail, eocd + 10);
    let dirSize = u32(tail, eocd + 12);
    let dirOffset = u32(tail, eocd + 16);
    if ((count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) && eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
      const at = u64(tail, eocd - 20 + 8);
      if (at + 56 > source.size) throw new ImportError("That zip's directory is damaged.");
      const z64 = await source.read(at, 56);
      if (u32(z64, 0) !== 0x06064b50) throw new ImportError("That zip's directory is damaged.");
      count = u64(z64, 32);
      dirSize = u64(z64, 40);
      dirOffset = u64(z64, 48);
    }
    if (count > ZIP_LIMITS.entries) throw new ImportError(`That zip holds more than ${ZIP_LIMITS.entries.toLocaleString("en-US")} files.`);
    if (dirSize > ZIP_LIMITS.directoryBytes || dirOffset + dirSize > source.size) throw new ImportError("That zip's directory is damaged.");
    const dir = await source.read(dirOffset, dirSize);
    const entries: ZipEntry[] = [];
    let refused = 0;
    let total = 0;
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > dir.length || u32(dir, at) !== 0x02014b50) throw new ImportError("That zip's directory is damaged.");
      const flags = u16(dir, at + 8);
      const method = u16(dir, at + 10);
      const crc = u32(dir, at + 16);
      let compressed = u32(dir, at + 20);
      let size = u32(dir, at + 24);
      const nameLength = u16(dir, at + 28);
      const extraLength = u16(dir, at + 30);
      const commentLength = u16(dir, at + 32);
      let offset = u32(dir, at + 42);
      const nameBytes = dir.subarray(at + 46, at + 46 + nameLength);
      const extra = dir.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = u16(extra, e);
        const len = u16(extra, e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          if (size === 0xffffffff && p + 8 <= e + 4 + len) (size = u64(extra, p)), (p += 8);
          if (compressed === 0xffffffff && p + 8 <= e + 4 + len) (compressed = u64(extra, p)), (p += 8);
          if (offset === 0xffffffff && p + 8 <= e + 4 + len) offset = u64(extra, p);
        }
        e += 4 + len;
      }
      at += 46 + nameLength + extraLength + commentLength;
      const raw = flags & 0x800 ? new TextDecoder().decode(nameBytes) : utf8OrLatin(nameBytes);
      const name = cleanEntryName(raw);
      if (!name) {
        refused++;
        continue;
      }
      if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").some((p) => p === ".DS_Store")) continue;
      if (flags & 0x1) {
        refused++;
        continue;
      }
      if (method !== 0 && method !== 8) {
        refused++;
        continue;
      }
      if (size > ZIP_LIMITS.ratioFloor && compressed > 0 && size / compressed > ZIP_LIMITS.ratio) {
        refused++;
        continue;
      }
      if (method === 0 && compressed !== size) {
        refused++;
        continue;
      }
      total += size;
      if (total > ZIP_LIMITS.totalBytes) throw new ImportError("That zip unpacks to more than 8 GB.");
      entries.push({ name, method, compressed, size, offset, crc });
    }
    return new ZipReader(entries, refused, source);
  }

  private async dataStart(entry: ZipEntry): Promise<number> {
    const head = await this.source.read(entry.offset, 30);
    if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw new ImportError(`${entry.name} is damaged in the zip.`);
    const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
    if (start + entry.compressed > this.source.size) throw new ImportError(`${entry.name} is cut short in the zip.`);
    return start;
  }

  async read(entry: ZipEntry, max: number): Promise<Uint8Array> {
    if (entry.size > max) throw new ImportError(`${entry.name} is too big to import.`);
    const start = await this.dataStart(entry);
    const packed = await this.source.read(start, entry.compressed);
    if (entry.method === 0) return checked(entry, packed);
    const out = new Uint8Array(entry.size);
    let produced: Uint8Array;
    try {
      produced = inflateSync(packed, { out });
    } catch {
      throw new ImportError(`${entry.name} couldn't be unpacked.`);
    }
    if (produced.length !== entry.size) throw new ImportError(`${entry.name} isn't the size the zip says.`);
    return checked(entry, produced);
  }

  async stream(entry: ZipEntry, sink: (chunk: Uint8Array) => Promise<void>, step = 4 * 1024 * 1024): Promise<void> {
    const start = await this.dataStart(entry);
    let crc = 0;
    let produced = 0;
    if (entry.method === 0) {
      for (let at = 0; at < entry.compressed; at += step) {
        const piece = await this.source.read(start + at, Math.min(step, entry.compressed - at));
        crc = crc32(piece, crc);
        produced += piece.length;
        await sink(piece);
      }
    } else {
      let pending: Uint8Array[] = [];
      let failed = false;
      const inflater = new Inflate((chunk) => {
        produced += chunk.length;
        if (produced > entry.size) failed = true;
        else {
          crc = crc32(chunk, crc);
          pending.push(chunk);
        }
      });
      for (let at = 0; at < entry.compressed; at += step) {
        const piece = await this.source.read(start + at, Math.min(step, entry.compressed - at));
        const last = at + piece.length >= entry.compressed;
        for (let from = 0; from < piece.length; from += INFLATE_INPUT) {
          const to = Math.min(piece.length, from + INFLATE_INPUT);
          try {
            inflater.push(piece.subarray(from, to), last && to >= piece.length);
          } catch {
            throw new ImportError(`${entry.name} couldn't be unpacked.`);
          }
          if (failed) throw new ImportError(`${entry.name} unpacks to more than the zip says.`);
          const ready = pending;
          pending = [];
          for (const c of ready) await sink(c);
        }
      }
    }
    if (produced !== entry.size) throw new ImportError(`${entry.name} isn't the size the zip says.`);
    if ((crc >>> 0) !== entry.crc >>> 0) throw new ImportError(`${entry.name} is damaged in the zip.`);
  }
}

function checked(entry: ZipEntry, data: Uint8Array): Uint8Array {
  if (data.length !== entry.size || (crc32(data) >>> 0) !== entry.crc) throw new ImportError(`${entry.name} is damaged in the zip.`);
  return data;
}

function utf8OrLatin(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return latin(bytes);
  }
}

export function isZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06);
}
