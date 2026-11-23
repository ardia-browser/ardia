import type { TotpSecret } from "./credentialTypes";

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function icbrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 3));
  for (;;) {
    const y = (2n * x + n / (x * x)) / 3n;
    if (y >= x) break;
    x = y;
  }
  while ((x + 1n) ** 3n <= n) x += 1n;
  while (x ** 3n > n) x -= 1n;
  return x;
}

function firstPrimes(count: number): bigint[] {
  const primes: bigint[] = [];
  for (let candidate = 2; primes.length < count; candidate++) {
    if (primes.every((p) => candidate % Number(p) !== 0)) primes.push(BigInt(candidate));
  }
  return primes;
}

const MASK64 = 0xffffffffffffffffn;

let roundConstants: { k512: bigint[]; h512: bigint[]; k256: Uint32Array; h256: Uint32Array } | null = null;

function constants() {
  if (roundConstants) return roundConstants;
  const primes = firstPrimes(80);
  const k512 = primes.map((p) => icbrt(p << 192n) & MASK64);
  const h512 = primes.slice(0, 8).map((p) => isqrt(p << 128n) & MASK64);
  const k256 = Uint32Array.from(k512.slice(0, 64).map((k) => Number(k >> 32n)));
  const h256 = Uint32Array.from(h512.map((h) => Number(h >> 32n)));
  roundConstants = { k512, h512, k256, h256 };
  return roundConstants;
}

function padded(bytes: Uint8Array, block: number, lengthBytes: number): Uint8Array {
  const total = Math.ceil((bytes.length + 1 + lengthBytes) / block) * block;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 0x80;
  let bits = BigInt(bytes.length) * 8n;
  for (let i = total - 1; i >= total - lengthBytes && bits > 0n; i--) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

function sha1(bytes: Uint8Array): Uint8Array {
  const m = padded(bytes, 64, 8);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let offset = 0; offset < m.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((m[offset + 4 * i]! << 24) | (m[offset + 4 * i + 1]! << 16) | (m[offset + 4 * i + 2]! << 8) | m[offset + 4 * i + 3]!) >>> 0;
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
  }
  return wordsToBytes(h);
}

function wordsToBytes(words: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    out[4 * i] = word >>> 24;
    out[4 * i + 1] = (word >>> 16) & 0xff;
    out[4 * i + 2] = (word >>> 8) & 0xff;
    out[4 * i + 3] = word & 0xff;
  }
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  const { k256, h256 } = constants();
  const m = padded(bytes, 64, 8);
  const h = Uint32Array.from(h256);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < m.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((m[offset + 4 * i]! << 24) | (m[offset + 4 * i + 1]! << 16) | (m[offset + 4 * i + 2]! << 8) | m[offset + 4 * i + 3]!) >>> 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = Array.from(h) as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k256[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return wordsToBytes(h);
}

const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64;

function sha512(bytes: Uint8Array): Uint8Array {
  const { k512, h512 } = constants();
  const m = padded(bytes, 128, 16);
  const h = [...h512];
  const w: bigint[] = new Array(80).fill(0n);
  for (let offset = 0; offset < m.length; offset += 128) {
    for (let i = 0; i < 16; i++) {
      let word = 0n;
      for (let j = 0; j < 8; j++) word = (word << 8n) | BigInt(m[offset + 8 * i + j]!);
      w[i] = word;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15]!, 1n) ^ rotr64(w[i - 15]!, 8n) ^ (w[i - 15]! >> 7n);
      const s1 = rotr64(w[i - 2]!, 19n) ^ rotr64(w[i - 2]!, 61n) ^ (w[i - 2]! >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, hh] = h as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    for (let i = 0; i < 80; i++) {
      const s1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const t1 = (hh + s1 + ch + k512[i]! + w[i]!) & MASK64;
      const s0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) & MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) & MASK64;
  }
  const out = new Uint8Array(64);
  h.forEach((word, i) => {
    for (let j = 0; j < 8; j++) out[8 * i + j] = Number((word >> BigInt(56 - 8 * j)) & 0xffn);
  });
  return out;
}

const HASHES = {
  SHA1: { digest: sha1, block: 64 },
  SHA256: { digest: sha256, block: 64 },
  SHA512: { digest: sha512, block: 128 },
} as const;

export function hmac(algorithm: TotpSecret["algorithm"], key: Uint8Array, message: Uint8Array): Uint8Array {
  const { digest, block } = HASHES[algorithm];
  const shortKey = key.length > block ? digest(key) : key;
  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + (algorithm === "SHA512" ? 64 : algorithm === "SHA256" ? 32 : 20));
  for (let i = 0; i < block; i++) {
    const byte = shortKey[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, block);
  outer.set(digest(inner), block);
  return digest(outer);
}

type SteamSecret = TotpSecret & { readonly steam: true };

const isSteam = (secret: TotpSecret): secret is SteamSecret => (secret as Partial<SteamSecret>).steam === true;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";
const LONGEST_TOTP_TEXT = 2048;

function base32(text: string): Uint8Array | null {
  const cleaned = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!cleaned || cleaned.length > LONGEST_TOTP_TEXT) return null;
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index < 0) return null;
    buffer = ((buffer << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes.length ? Uint8Array.from(bytes) : null;
}

function decodeComponent(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function queryOf(rest: string): Map<string, string> | null {
  const start = rest.indexOf("?");
  const text = start >= 0 ? rest.slice(start + 1).split("#")[0]! : "";
  const query = new Map<string, string>();
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const name = decodeComponent(equals >= 0 ? pair.slice(0, equals) : pair);
    const value = decodeComponent(equals >= 0 ? pair.slice(equals + 1) : "");
    if (name === null || value === null) return null;
    const key = name.toLowerCase();
    if (!query.has(key)) query.set(key, value.trim());
  }
  return query;
}

function algorithmNamed(name: string): TotpSecret["algorithm"] | null {
  let plain = name.toLowerCase().replace(/[-_\s]/g, "");
  if (plain.startsWith("hmac")) plain = plain.slice(4);
  return plain === "sha1" ? "SHA1" : plain === "sha256" ? "SHA256" : plain === "sha512" ? "SHA512" : null;
}

const steamSecret = (secret: Uint8Array, period = 30): SteamSecret => ({ secret, period, digits: 5, algorithm: "SHA1", steam: true });

function parseOtpauth(trimmed: string): TotpSecret | null {
  const rest = trimmed.slice("otpauth://".length);
  const slash = rest.search(/[/?#]/);
  if ((slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase() !== "totp") return null;
  const query = queryOf(rest);
  const secretText = query?.get("secret");
  const secret = secretText ? base32(secretText) : null;
  if (!query || !secret) return null;
  const digitsText = query.get("digits") ?? "";
  const periodText = query.get("period") ?? "";
  if (!/^\d{0,3}$/.test(digitsText) || !/^\d{0,4}$/.test(periodText)) return null;
  const period = periodText ? Number(periodText) : 30;
  if (period < 5 || period > 300) return null;
  const algorithmText = query.get("algorithm") ?? "";
  const algorithm = algorithmText ? algorithmNamed(algorithmText) : "SHA1";
  if (!algorithm) return null;
  const steam = (query.get("encoder") ?? "").toLowerCase() === "steam" || (digitsText === "5" && (query.get("issuer") ?? "").toLowerCase() === "steam");
  if (steam) return digitsText && digitsText !== "5" ? null : { ...steamSecret(secret, period), algorithm };
  const digits = digitsText ? Number(digitsText) : 6;
  if (digits < 6 || digits > 8) return null;
  return { secret, period, digits, algorithm };
}

function parseTotp(text: string): TotpSecret | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > LONGEST_TOTP_TEXT) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("steam://")) {
    const secret = base32(trimmed.slice("steam://".length));
    return secret ? steamSecret(secret) : null;
  }
  if (lowered.startsWith("otpauth://")) return parseOtpauth(trimmed);
  if (trimmed.includes("://")) return null;
  const secret = base32(trimmed);
  return secret ? { secret, period: 30, digits: 6, algorithm: "SHA1" } : null;
}

function totpCode(secret: TotpSecret, atMs: number): string {
  const seconds = atMs / 1000;
  const counter = seconds > 0 && Number.isFinite(seconds) ? Math.floor(seconds / secret.period) : 0;
  const message = new Uint8Array(8);
  let rest = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    message[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  const mac = hmac(secret.algorithm, secret.secret, message);
  const offset = mac[mac.length - 1]! & 0x0f;
  let binary = (((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!) >>> 0;
  if (isSteam(secret)) {
    let letters = "";
    for (let i = 0; i < 5; i++) {
      letters += STEAM_ALPHABET[binary % STEAM_ALPHABET.length];
      binary = Math.floor(binary / STEAM_ALPHABET.length);
    }
    return letters;
  }
  return String(binary % 10 ** secret.digits).padStart(secret.digits, "0");
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export const totp = {
  parse: parseTotp,
  period(uri: string): number | undefined {
    if (!uri.includes("://")) return undefined;
    return parseTotp(uri)?.period;
  },
  code: totpCode,
  same(a: string, b: string): boolean {
    const left = parseTotp(a);
    const right = parseTotp(b);
    if (!left || !right) return false;
    return left.period === right.period && left.digits === right.digits && left.algorithm === right.algorithm && isSteam(left) === isSteam(right) && sameBytes(left.secret, right.secret);
  },
};
