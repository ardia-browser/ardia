import type { VaultLoginEdit } from "../../platform/vaults";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LONGEST = 2048;

export function normalizeWebsite(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > LONGEST || /\s/.test(trimmed)) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host || url.username || url.password) return null;
  const local = LOCAL.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (!local && (!host.includes(".") || host.startsWith(".") || host.endsWith(".") || host.includes(".."))) return null;
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

type Saved = { origin: string; username: string };

const realm = (origin: string) => origin.replace(/\/+$/, "").toLowerCase();

export function existingLogin<T extends Saved>(saved: readonly T[], origin: string, username: string, self: Saved | null = null): T | null {
  const wanted = realm(origin);
  const name = username.trim();
  return saved.find((s) => s !== self && realm(s.origin) === wanted && s.username === name && !(self && realm(self.origin) === wanted && self.username === name)) ?? null;
}

export type LoginFormProblem = "website" | "password" | "duplicate" | "label" | "code";

type FormState =
  | { mode: "password"; website: string; username: string; passwordLength: number; saved: readonly Saved[]; self?: Saved | null; keepsPassword?: boolean }
  | { mode: "code"; website: string; label: string; hasCode: boolean; saved: readonly Saved[] };

export function loginFormProblem(form: FormState): LoginFormProblem | null {
  if (form.mode === "code") {
    if (!form.hasCode) return "code";
    if (!form.label.trim()) return "label";
    return form.website.trim() && !normalizeWebsite(form.website) ? "website" : null;
  }
  const origin = normalizeWebsite(form.website);
  if (!origin) return "website";
  if (form.passwordLength === 0 && !form.keepsPassword) return "password";
  return existingLogin(form.saved, origin, form.username, form.self ?? null) ? "duplicate" : null;
}

type Edited = { website: string; username: string; passwordDraft?: string; codeToken?: string; removeCode?: boolean };

export function editOf(was: { website: string; username: string }, now: Edited): VaultLoginEdit {
  const edit: VaultLoginEdit = {};
  const origin = normalizeWebsite(now.website);
  if (origin && origin !== normalizeWebsite(was.website)) edit.url = origin;
  if (now.username.trim() !== was.username) edit.username = now.username.trim();
  if (now.passwordDraft) edit.passwordDraft = now.passwordDraft;
  if (now.codeToken) edit.totp = { token: now.codeToken };
  else if (now.removeCode) edit.totp = { remove: true };
  return edit;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return bytes;
}

export function ardiaLoginId(profile: string, origin: string, username: string): string {
  const bytes = utf8(`${profile}\n${origin.replace(/\/+$/, "")}\n${username}`);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}
