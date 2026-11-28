import { isPlainObject } from "./spec";

export type SignedEnvelope<T = unknown> = { v: 1; kid: string; sig: string; payload: T };

export type PublicKeys = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

export type VerifyResult<T> = { ok: true; kid: string; payload: T } | { ok: false; reason: string };

type CryptoKeyLike = unknown;

export type SubtleLike = {
  importKey(format: "spki" | "raw" | "pkcs8", keyData: Uint8Array, algorithm: { name: "Ed25519" }, extractable: boolean, usages: string[]): Promise<CryptoKeyLike>;
  sign(algorithm: { name: "Ed25519" }, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: { name: "Ed25519" }, key: CryptoKeyLike, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
};

export type CryptoOptions = { subtle?: SubtleLike };

export const REGISTRY_ENVELOPE_VERSION = 1;

export const REGISTRY_SIGNATURE_DOMAIN = "ardia-registry-v1\n";

export const ENVELOPE_CONTEXT = REGISTRY_SIGNATURE_DOMAIN;

const SIG_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export const KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const ED25519 = { name: "Ed25519" } as const;

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function encodeString(text: string, path: string): string {
  if (hasLoneSurrogate(text)) throw new CanonicalJsonError(`canonicalJson can't encode a lone surrogate at ${path}`);
  return JSON.stringify(text);
}

const compareUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`canonicalJson can't encode a non-finite number at ${path}`);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return encodeString(value, path);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`canonicalJson can't encode a ${typeof value} at ${path}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CanonicalJsonError(`canonicalJson can't encode an invalid Date at ${path}`);
    return JSON.stringify(value.toISOString());
  }
  const object = value as object;
  if (seen.has(object)) throw new CanonicalJsonError(`canonicalJson can't encode a cycle at ${path}`);
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let i = 0; i < object.length; i++) {
        const item: unknown = object[i];
        parts.push(item === undefined || typeof item === "function" || typeof item === "symbol" ? "null" : encode(item, `${path}[${i}]`, seen));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(object)) throw new CanonicalJsonError(`canonicalJson can't encode an object that isn't plain at ${path}`);
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareUnits);
    return `{${keys.map((key) => `${encodeString(key, `${path} key`)}:${encode(object[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    out += b === undefined ? "=" : ALPHABET[(n >> 6) & 63]!;
    out += c === undefined ? "=" : ALPHABET[n & 63]!;
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  return fromBase64(text);
}

export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const found = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  return found ? fromBase64(found[1] ?? "") : null;
}

function subtleOf(options: CryptoOptions): SubtleLike {
  const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!subtle) throw new Error("There's no WebCrypto here; pass options.subtle to sign or verify registry envelopes.");
  return subtle;
}

async function publicKey(subtle: SubtleLike, text: string): Promise<CryptoKeyLike | null> {
  const spki = text.includes("-----BEGIN") ? pemBody(text, "PUBLIC KEY") : null;
  if (spki) return subtle.importKey("spki", spki, ED25519, false, ["verify"]);
  const raw = fromBase64(text);
  if (raw && raw.length === 32) return subtle.importKey("raw", raw, ED25519, false, ["verify"]);
  return null;
}

export const envelopeMessage = (kid: string, payload: unknown): Uint8Array => utf8(REGISTRY_SIGNATURE_DOMAIN + canonicalJson({ v: REGISTRY_ENVELOPE_VERSION, kid, payload }));

export async function signEnvelope<T>(payload: T, kid: string, privateKeyPem: string, options: CryptoOptions = {}): Promise<SignedEnvelope<T>> {
  if (!KID_PATTERN.test(kid)) throw new Error("kid must be 1 to 128 letters, digits, ., _, : and -");
  const pkcs8 = pemBody(privateKeyPem, "PRIVATE KEY");
  if (!pkcs8) throw new Error("The private key must be a PKCS #8 PEM (-----BEGIN PRIVATE KEY-----).");
  const subtle = subtleOf(options);
  const key = await subtle.importKey("pkcs8", pkcs8, ED25519, false, ["sign"]);
  const signature = new Uint8Array(await subtle.sign(ED25519, key, envelopeMessage(kid, payload)));
  return { v: 1, kid, sig: toBase64Url(signature), payload };
}

const lookup = (keys: PublicKeys, kid: string): string | undefined =>
  keys instanceof Map ? keys.get(kid) : Object.hasOwn(keys, kid) ? (keys as Record<string, string>)[kid] : undefined;

export async function verifyEnvelope<T = unknown>(envelope: unknown, publicKeys: PublicKeys, options: CryptoOptions = {}): Promise<VerifyResult<T>> {
  if (!isPlainObject(envelope)) return { ok: false, reason: "The envelope isn't an object" };
  const extra = Object.keys(envelope).filter((key) => !["v", "kid", "sig", "payload"].includes(key));
  if (extra.length) return { ok: false, reason: `The envelope has unknown keys: ${extra.join(", ")}` };
  const { v, kid, sig, payload } = envelope;
  if (v !== 1) return { ok: false, reason: "The envelope's v must be 1" };
  if (typeof kid !== "string" || !KID_PATTERN.test(kid)) return { ok: false, reason: "The envelope's kid must be 1 to 128 letters, digits, ., _, : and -" };
  if (typeof sig !== "string") return { ok: false, reason: "The envelope has no sig" };
  if (!("payload" in envelope)) return { ok: false, reason: "The envelope has no payload" };
  const keyText = lookup(publicKeys, kid);
  if (!keyText) return { ok: false, reason: `No trusted key has the id ${kid}` };
  const signature = SIG_PATTERN.test(sig) ? fromBase64Url(sig) : null;
  if (!signature || signature.length !== 64) return { ok: false, reason: "The signature isn't 64 bytes of unpadded base64url" };
  let message: Uint8Array;
  try {
    message = envelopeMessage(kid, payload);
  } catch (error) {
    return { ok: false, reason: `The payload can't be made canonical: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const subtle = subtleOf(options);
    const key = await publicKey(subtle, keyText);
    if (!key) return { ok: false, reason: `The trusted key ${kid} isn't an Ed25519 public key` };
    const valid = await subtle.verify(ED25519, key, signature, message);
    return valid ? { ok: true, kid, payload: payload as T } : { ok: false, reason: "The signature doesn't match" };
  } catch (error) {
    return { ok: false, reason: `The signature couldn't be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
}
