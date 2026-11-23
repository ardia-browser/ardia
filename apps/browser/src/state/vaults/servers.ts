import type { SignInServer } from "./providerModel";

export type ServerPick = { id: string; url: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_URL = 2048;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const comparable = (url: string) => url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/:443$/, "");

export function customServerURL(typed: string): string | null {
  const text = typed.trim().replace(/\/+$/, "");
  if (!text || text.length > MAX_URL || /\s/.test(text)) return null;
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;
  const loopback = LOOPBACK.has(url.hostname.toLowerCase());
  if (url.protocol === "http:" && !loopback) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!loopback && !url.hostname.includes(".")) return null;
  return full;
}

export function initialServer(servers: readonly SignInServer[], current: string | undefined | null): ServerPick {
  const first = servers[0];
  if (!first) return { id: "", url: "" };
  const now = current?.trim() ?? "";
  if (!now) return { id: first.id, url: "" };
  const preset = servers.find((s) => s.id === now || (s.url && comparable(s.url) === comparable(now)));
  if (preset) return { id: preset.id, url: "" };
  const custom = servers.find((s) => s.custom);
  return custom && hostOf(customServerURL(now) ?? "") ? { id: custom.id, url: now } : { id: first.id, url: "" };
}

export function serverValue(servers: readonly SignInServer[], pick: ServerPick): string | null | undefined {
  const chosen = servers.find((s) => s.id === pick.id);
  if (!chosen) return undefined;
  if (!chosen.custom) return chosen.id;
  return customServerURL(pick.url);
}

export function serverLabel(servers: readonly SignInServer[], current: string | undefined | null): string | null {
  if (!servers.length || !current) return null;
  const pick = initialServer(servers, current);
  if (pick.id === servers[0]!.id) return null;
  const chosen = servers.find((s) => s.id === pick.id);
  if (chosen?.custom) return hostOf(customServerURL(pick.url) ?? "") || null;
  return chosen?.title ?? null;
}
