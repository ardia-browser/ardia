import { gzipSync, constants } from "node:zlib";

export type TarEntry = { path: string; type: "file" | "directory"; mode: number; data?: Uint8Array };

const BLOCK = 512;

export const MAX_TAR_ENTRIES = 20_000;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function writeString(header: Buffer, text: string, offset: number, width: number) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > width) throw new Error(`${text} doesn't fit a ${width}-byte tar field`);
  bytes.copy(header, offset);
}

export function splitUstar(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}

function header(path: string, typeflag: string, mode: number, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const split = splitUstar(path) ?? { name: truncateUtf8(path, 100), prefix: "" };
  writeString(block, split.name, 0, 100);
  writeString(block, octal(mode & 0o7777, 8), 100, 8);
  writeString(block, octal(0, 8), 108, 8);
  writeString(block, octal(0, 8), 116, 8);
  writeString(block, octal(size, 12), 124, 12);
  writeString(block, octal(0, 12), 136, 12);
  block.fill(0x20, 148, 156);
  writeString(block, typeflag, 156, 1);
  writeString(block, "ustar\0", 257, 6);
  writeString(block, "00", 263, 2);
  writeString(block, split.prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function pad(size: number): Buffer {
  const rest = size % BLOCK;
  return Buffer.alloc(rest ? BLOCK - rest : 0, 0);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

export const normalizedMode = (entry: Pick<TarEntry, "type" | "mode">): number => (entry.type === "directory" || (entry.mode & 0o100) !== 0 ? 0o755 : 0o644);

export function tarBytes(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  let count = 0;
  const counted = () => {
    if (++count > MAX_TAR_ENTRIES) throw new TarError(`The pack would hold more than ${MAX_TAR_ENTRIES} tar entries`);
  };
  for (const entry of entries) {
    const path = entry.type === "directory" ? `${entry.path.replace(/\/$/, "")}/` : entry.path;
    if (!splitUstar(path)) {
      counted();
      const pax = Buffer.from(paxRecord("path", path), "utf8");
      chunks.push(header(`PaxHeaders/${truncateUtf8(path.split("/").pop() ?? "entry", 80)}`, "x", 0o644, pax.length), pax, pad(pax.length));
    }
    counted();
    const data = entry.type === "file" ? Buffer.from(entry.data ?? new Uint8Array()) : Buffer.alloc(0);
    chunks.push(header(path, entry.type === "file" ? "0" : "5", normalizedMode(entry), data.length));
    if (data.length) chunks.push(data, pad(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

export function gzipDeterministic(data: Buffer): Buffer {
  const out = gzipSync(data, { level: constants.Z_BEST_COMPRESSION, memLevel: 9 });
  out.writeUInt32LE(0, 4);
  out[9] = 0xff;
  return out;
}
