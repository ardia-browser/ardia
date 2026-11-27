import { isFields } from "../../lib/decode";
import type { PluginManifest } from "../../lib/pluginManifest";
import { isDeniedSiteHeader, STANDARD_SITE_HEADERS } from "../../lib/pluginPermissions";
import { pluginWebUrl } from "../../lib/pluginWebUrl";
import { secureRandomHex } from "../../platform/secureRandom";
import { KEPT_RESPONSE_HEADERS } from "./siteScripts";

export const SITE_HEADER_LIMITS = { headers: 20, valueBytes: 1024 } as const;

export type SiteTarget = { url: string; origin: string; host: string };

export function siteTarget(m: PluginManifest, raw: unknown): SiteTarget | string {
  const checked = pluginWebUrl(raw);
  if ("problem" in checked) return `url ${checked.problem}.`;
  if (!m.permissions.sites.includes(checked.host)) return `${checked.host} isn't one of the sites this plugin may use your sign-in on (${m.permissions.sites.join(", ")}).`;
  const origin = `https://${checked.host}`;
  if (checked.url !== origin && !checked.url.startsWith(`${origin}/`)) return "url must be https on the site's own port, like https://www.example/path.";
  const hash = checked.url.indexOf("#");
  return { url: hash < 0 ? checked.url : checked.url.slice(0, hash), origin, host: checked.host };
}

export function siteHeadersOf(raw: unknown, allowed: readonly string[] = []): Record<string, string> | string {
  if (raw === undefined) return {};
  if (!isFields(raw)) return "headers is an object of header names to text.";
  const entries = Object.entries(raw);
  if (entries.length > SITE_HEADER_LIMITS.headers) return `headers has more than ${SITE_HEADER_LIMITS.headers} entries.`;
  const out: Record<string, string> = Object.create(null);
  for (const [given, value] of entries) {
    const name = given.toLowerCase();
    if (isDeniedSiteHeader(name)) return `Ardia sets ${given.slice(0, 64)} itself, or never sends it for a plugin.`;
    if (!(STANDARD_SITE_HEADERS as readonly string[]).includes(name) && !allowed.includes(name)) return `headers.${given.slice(0, 64)} isn't a header this plugin may send: a standard one like content-type, or one its manifest lists in permissions.siteHeaders.`;
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value) || new TextEncoder().encode(value).length > SITE_HEADER_LIMITS.valueBytes) return `headers.${name} must be text on one line, at most ${SITE_HEADER_LIMITS.valueBytes} bytes.`;
    out[name] = value;
  }
  return { ...out };
}

export function cleanHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isFields(raw)) return out;
  for (const [name, value] of Object.entries(raw)) if (typeof value === "string" && (KEPT_RESPONSE_HEADERS.includes(name) || /^x-ratelimit-[a-z-]{1,40}$/.test(name))) out[name] = value.slice(0, 2048);
  return out;
}

export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export const decodedBytes = (base64: string) => (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

export type SitePlace = { profile: string; windowId: string };

export type SiteTransport = {
  open(plugin: string, origin: string, place: SitePlace): Promise<{ ok: true; key: string } | { ok: false; reason: string }>;
  run<T>(key: string, script: string, ms: number, stop?: Promise<unknown>): Promise<T | null>;
  alive(key: string): boolean;
  dropPlugin(plugin: string): void;
};

export const stageId = () => {
  const h = secureRandomHex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const fileFailure = (outcome: unknown): { code: string; message: string } => {
  const code = isFields(outcome) && typeof outcome.code === "string" ? outcome.code : "failed";
  const text = isFields(outcome) && typeof outcome.message === "string" ? outcome.message : "no space or no access";
  if (code === "exists") return { code, message: "A file is already at that path; remove it or pick another." };
  if (code === "quota") return { code, message: `The plugin's files are full (${text}).` };
  return { code: "failed", message: `The file couldn't be saved: ${text}.` };
};
