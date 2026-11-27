const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

const nativeBtoa: ((text: string) => string) | null = typeof (globalThis as { btoa?: unknown }).btoa === "function" ? (globalThis as unknown as { btoa: (text: string) => string }).btoa : null;
const LATIN_SLICE = 8190;
const DECODE = (() => {
  const table = new Int32Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  if (nativeBtoa && bytes.length >= 64) {
    try {
      return nativeToBase64(bytes, nativeBtoa);
    } catch {}
  }
  return scriptToBase64(bytes);
}

function nativeToBase64(bytes: Uint8Array, encode: (text: string) => string): string {
  const parts: string[] = [];
  const step = LATIN_SLICE * 3;
  for (let at = 0; at < bytes.length; at += step) {
    const slice = bytes.subarray(at, Math.min(bytes.length, at + step));
    let latin = "";
    for (let j = 0; j < slice.length; j += LATIN_SLICE) latin += String.fromCharCode.apply(null, slice.subarray(j, j + LATIN_SLICE) as unknown as number[]);
    parts.push(encode(latin));
  }
  return parts.join("");
}

function scriptToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let line = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    line += B64[v >> 18]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
    if (line.length >= 32768) {
      parts.push(line);
      line = "";
    }
  }
  if (i < n) {
    const a = bytes[i]!;
    const b = i + 1 < n ? bytes[i + 1]! : 0;
    const v = (a << 16) | (b << 8);
    line += B64[v >> 18]! + B64[(v >> 12) & 63]! + (i + 1 < n ? B64[(v >> 6) & 63]! : "=") + "=";
  }
  parts.push(line);
  return parts.join("");
}

export function fromBase64(text: string): Uint8Array {
  return quadsFromBase64(text) ?? looseFromBase64(text);
}

function quadsFromBase64(text: string): Uint8Array | null {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  const table = DECODE;
  const whole = end - (end % 4);
  let o = 0;
  for (let i = 0; i < whole; i += 4) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    const c3 = text.charCodeAt(i + 3);
    if ((c0 | c1 | c2 | c3) > 255) return null;
    const v = (table[c0]! << 18) | (table[c1]! << 12) | (table[c2]! << 6) | table[c3]!;
    if (v < 0) return null;
    out[o] = v >> 16;
    out[o + 1] = v >> 8;
    out[o + 2] = v;
    o += 3;
  }
  const rest = end - whole;
  if (rest === 1) return null;
  if (rest > 1) {
    const c0 = text.charCodeAt(whole);
    const c1 = text.charCodeAt(whole + 1);
    const c2 = rest === 3 ? text.charCodeAt(whole + 2) : 65;
    if ((c0 | c1 | c2) > 255) return null;
    const v = (table[c0]! << 18) | (table[c1]! << 12) | (table[c2]! << 6);
    if (v < 0) return null;
    out[o++] = v >> 16;
    if (rest === 3) out[o++] = v >> 8;
  }
  return o === out.length ? out : out.subarray(0, o);
}

function looseFromBase64(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 61 || text.charCodeAt(end - 1) <= 32)) end--;
  const out = new Uint8Array(Math.floor((end * 3) / 4) + 3);
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    const d = c < 256 ? LOOKUP[c]! : -1;
    if (d < 0) {
      if (c <= 32) continue;
      throw new Error("That isn't valid base64.");
    }
    value = (value << 6) | d;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return hex(bytes);
}

const CRC_TABLES = (() => {
  const tables = new Int32Array(1024);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n]!;
    for (let t = 1; t < 4; t++) {
      c = tables[c & 255]! ^ (c >>> 8);
      tables[t * 256 + n] = c;
    }
  }
  return tables;
})();

export function crc32(bytes: Uint8Array): number {
  const t = CRC_TABLES;
  let c = -1;
  const n = bytes.length;
  let i = 0;
  for (const whole = n - (n & 3); i < whole; i += 4) {
    c ^= bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    c = t[768 + (c & 255)]! ^ t[512 + ((c >>> 8) & 255)]! ^ t[256 + ((c >>> 16) & 255)]! ^ t[c >>> 24]!;
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
