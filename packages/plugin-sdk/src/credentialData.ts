import { CredentialError } from "./credentialErrors";
import type { JsonRecord } from "./credentialTypes";

export const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

function jsonString(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function jsonList(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw CredentialError.failed("unreadable");
  return value.filter(isRecord);
}

export const json = {
  record(value: unknown): JsonRecord {
    if (!isRecord(value)) throw CredentialError.failed("unreadable");
    return value;
  },
  list: jsonList,
  listAt(value: unknown, key: string): JsonRecord[] {
    return jsonList(json.record(value)[key]);
  },
  dict(value: unknown): JsonRecord | undefined {
    return isRecord(value) ? value : undefined;
  },
  dicts(value: unknown): JsonRecord[] {
    return Array.isArray(value) ? value.filter(isRecord) : [];
  },
  string: jsonString,
  strings(value: unknown): string[] {
    return Array.isArray(value) ? value.flatMap((entry) => jsonString(entry) ?? []) : [];
  },
  int(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && /^[+-]?\d{1,15}$/.test(value)) return Number.parseInt(value, 10);
    return undefined;
  },
  bool(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    return undefined;
  },
  milliseconds(value: unknown): number | undefined {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value <= 0) return undefined;
      return value > 100_000_000_000 ? value : value * 1000;
    }
    if (typeof value !== "string" || value === "") return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  },
};

const URL_SHAPE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/;

export type UrlParts = { scheme: string; host: string; userinfo: boolean };

export function urlParts(url: string): UrlParts | undefined {
  const match = URL_SHAPE.exec(url.trim());
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase();
  let authority = match[2]!;
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0;
  if (userinfo) authority = authority.slice(at + 1);
  let host: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return undefined;
    host = authority.slice(0, end + 1);
  } else {
    const colon = authority.indexOf(":");
    host = colon >= 0 ? authority.slice(0, colon) : authority;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (!host || /[\s\\%]/.test(host)) return undefined;
  return { scheme, host, userinfo };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host.trim().toLowerCase());

export const origins = {
  host(url: string): string | undefined {
    return urlParts(url)?.host;
  },
  isLocalHost: isLoopbackHost,
  isWebOrigin(url: string): boolean {
    const parsed = urlParts(url);
    return !!parsed && (parsed.scheme === "http" || parsed.scheme === "https") && !parsed.userinfo;
  },
  hostIn(url: string, allowed: readonly string[]): boolean {
    const host = urlParts(url)?.host;
    if (!host) return false;
    return allowed.some((entry) => {
      const plain = entry.toLowerCase();
      return host === plain || host.endsWith(`.${plain}`);
    });
  },
};

export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if ((low & 0xfc00) === 0xdc00) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
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

export function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}

export function sortedJson(value: unknown, depthLimit = Number.POSITIVE_INFINITY, depth = 0): string {
  if (depth > depthLimit) throw new RangeError("too deep");
  if (Array.isArray(value)) return `[${value.map((entry) => sortedJson(entry ?? null, depthLimit, depth + 1)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(value[key], depthLimit, depth + 1)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("not JSON");
  return encoded;
}

export function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, into);
  else if (isRecord(value)) for (const entry of Object.values(value)) stringsIn(entry, into);
  return into;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const length = Math.min(3, bytes.length - i);
    for (let j = 0; j <= length; j++) out += alphabet[(chunk >> (18 - 6 * j)) & 63];
    if (pad) out += "=".repeat(3 - length);
  }
  return out;
}

export const base64 = (bytes: Uint8Array) => encode(bytes, BASE64, true);

export const base64url = {
  encode: (bytes: Uint8Array) => encode(bytes, BASE64URL, false),
  decode(text: string, longest?: number): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
    if (longest !== undefined && Math.floor((text.length * 3) / 4) > longest) return null;
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const character of text) {
      buffer = ((buffer << 6) | BASE64URL.indexOf(character)) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return Uint8Array.from(bytes);
  },
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const uuids = {
  bytes(uuid: string): Uint8Array | null {
    if (!UUID.test(uuid)) return null;
    const hex = uuid.replace(/-/g, "");
    return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
  },
  string(bytes: Uint8Array): string | null {
    if (bytes.length !== 16) return null;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
};
