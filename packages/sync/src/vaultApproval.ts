import type { Adapter } from "./scopeState.ts";

export const VAULT_PREFIX = "vault:";
export const VAULT_REQUEST = "vault:q:";
export const VAULT_ANSWER = "vault:a:";
export const VAULT_KEY = "vault:k:";
export const VAULT_TRUST = "vault:t:";
export const VAULT_REQUEST_MAX_MS = 10 * 60_000;

export type VaultRequestRecord = { id: string; n: string; p: string; pn: string; g: string; s: string[]; w: string; x: number; m: string; ao: boolean; at: number };
export type VaultAnswerRecord = { id: string; n: string; p: string; s: string[]; x: number; m: string; a: boolean; al: boolean; by: string; sig: string; at: number };
export type VaultKeyRecord = { k: string; f: string; by: string; at: number };
export type VaultTrustRecord = { f: string; at: number };

const MAX_SITES = 32;
const MAX_TEXT = 300;
const ID = /^[0-9a-f-]{8,64}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT = /^[0-9A-F]{4}( [0-9A-F]{4}){4}$/;

const text = (v: unknown, max = MAX_TEXT) => typeof v === "string" && v.length <= max;

export function vaultOrigin(site: unknown): string | null {
  if (typeof site !== "string" || site.length > 2048) return null;
  try {
    const url = new URL(site);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin === site ? site : null;
  } catch {
    return null;
  }
}

const sitesOk = (s: unknown): s is string[] => Array.isArray(s) && s.length > 0 && s.length <= MAX_SITES && s.every((site) => vaultOrigin(site) !== null) && new Set(s).size === s.length;

export function vaultRequestOf(key: string, v: unknown): VaultRequestRecord | null {
  if (!key.startsWith(VAULT_REQUEST) || !v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = key.slice(VAULT_REQUEST.length);
  if (r.id !== id || !ID.test(id) || !text(r.n, 128) || (r.n as string).length < 16 || !text(r.p, 128) || !text(r.pn) || !text(r.g) || !text(r.w) || !text(r.m, 128)) return null;
  if (!sitesOk(r.s) || typeof r.ao !== "boolean" || !Number.isSafeInteger(r.x) || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  return r as VaultRequestRecord;
}

export function vaultAnswerOf(key: string, v: unknown): VaultAnswerRecord | null {
  if (!key.startsWith(VAULT_ANSWER) || !v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = key.slice(VAULT_ANSWER.length);
  if (r.id !== id || !ID.test(id) || !text(r.n, 128) || !text(r.p, 128) || !text(r.m, 128) || !text(r.by, 128) || !sitesOk(r.s) || !text(r.sig, 200) || (r.a === true ? !BASE64.test(r.sig as string) : r.sig !== "")) return null;
  if (typeof r.a !== "boolean" || typeof r.al !== "boolean" || typeof r.x !== "number" || typeof r.at !== "number") return null;
  return r as VaultAnswerRecord;
}

export const vaultAnswerFits = (request: VaultRequestRecord, answer: VaultAnswerRecord) =>
  answer.id === request.id &&
  answer.n === request.n &&
  answer.p === request.p &&
  answer.m === request.m &&
  answer.x === request.x &&
  (!answer.al || request.ao) &&
  answer.s.length === request.s.length &&
  answer.s.every((site, i) => site === request.s[i]);

export function vaultKeyOf(key: string, v: unknown): VaultKeyRecord | null {
  if (!key.startsWith(VAULT_KEY) || !v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const device = key.slice(VAULT_KEY.length);
  if (r.by !== device || !DEVICE.test(device) || !text(r.k, 200) || !BASE64.test(r.k as string) || typeof r.f !== "string" || !FINGERPRINT.test(r.f) || typeof r.at !== "number") return null;
  return r as VaultKeyRecord;
}

export const vaultTrustKey = (phone: string, mac: string) => `${VAULT_TRUST}${phone}:${mac}`;

export function vaultTrustOf(key: string, v: unknown): (VaultTrustRecord & { phone: string; mac: string }) | null {
  if (!key.startsWith(VAULT_TRUST) || !v || typeof v !== "object") return null;
  const [phone, mac, extra] = key.slice(VAULT_TRUST.length).split(":");
  const f = (v as Record<string, unknown>).f;
  if (extra !== undefined || !phone || !mac || !DEVICE.test(phone) || !DEVICE.test(mac) || typeof f !== "string" || !FINGERPRINT.test(f)) return null;
  return { f, at: Number((v as Record<string, unknown>).at) || 0, phone, mac };
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const VAULT_CHALLENGE_TAG = "ardia-vault-answer-1";

export function vaultChallenge(request: VaultRequestRecord, by: string, allow: boolean, always: boolean): string {
  const fields = [VAULT_CHALLENGE_TAG, request.id, request.n, request.p, String(request.s.length), ...request.s, String(request.x), request.ao ? "1" : "0", request.m, by, allow ? "1" : "0", allow && always && request.ao ? "1" : "0"];
  return fields.map((field) => `${utf8Length(field)}:${field}`).join("");
}

export function vaultAnswerFor(request: VaultRequestRecord, allow: boolean, always: boolean, by: string, at: number, sig: string): VaultAnswerRecord {
  return { id: request.id, n: request.n, p: request.p, s: [...request.s], x: request.x, m: request.m, a: allow, al: allow && always && request.ao, by, sig, at };
}

export type VaultAsks = {
  me: string;
  live: () => VaultRequestRecord[];
  isPhone: (device: string) => boolean;
  author: (key: string) => string | undefined;
  trusts: () => { phone: string; f: string }[];
  answered: (request: VaultRequestRecord, answer: VaultAnswerRecord) => void;
};

export function vaultRequestsAdapter(asks: VaultAsks): Adapter {
  const liveById = () => new Map(asks.live().map((r) => [r.id, r]));
  return {
    prefix: VAULT_PREFIX,
    extract: (base) => {
      const live = liveById();
      const values = new Map<string, unknown>([...live.values()].map((r) => [`${VAULT_REQUEST}${r.id}`, r]));
      for (const { phone, f } of asks.trusts()) values.set(vaultTrustKey(phone, asks.me), { f, at: 0 } satisfies VaultTrustRecord);
      const ignore = (k: string) => {
        const trust = vaultTrustOf(k, base(k));
        if (trust) return trust.mac !== asks.me;
        const request = vaultRequestOf(k, base(k));
        if (request) return request.m !== asks.me;
        const answer = vaultAnswerOf(k, base(k));
        if (answer) return answer.m !== asks.me || live.has(answer.id);
        return true;
      };
      return { values, ignore };
    },
    apply: (visible, changed) => {
      const live = liveById();
      for (const key of changed) {
        const answer = vaultAnswerOf(key, visible.get(key));
        const request = answer && live.get(answer.id);
        if (!answer || !request || !vaultAnswerFits(request, answer) || !asks.isPhone(answer.by) || asks.author(key) !== answer.by) continue;
        live.delete(answer.id);
        asks.answered(request, answer);
      }
      return true;
    },
  };
}
