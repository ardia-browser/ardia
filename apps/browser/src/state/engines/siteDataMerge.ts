import type { ChromiumCookieWrite, CookieRemoval, PageCookie, StorageItems } from "../../platform/webkit";

const knownDomains = new Map<string, string>();
const MAX_KNOWN_DOMAINS = 4000;

export const bareHost = (host: string) => host.toLowerCase().replace(/^\.+|\.+$/g, "");

export function registrableDomain(host: string): string {
  const bare = bareHost(host);
  return knownDomains.get(bare) ?? bare;
}

export const knowsRegistrableDomain = (host: string) => knownDomains.has(bareHost(host));

export function rememberRegistrableDomain(host: string, domain: string) {
  const bare = bareHost(host);
  const site = bareHost(domain);
  if (!bare || !site || !(bare === site || bare.endsWith(`.${site}`))) return;
  if (knownDomains.size >= MAX_KNOWN_DOMAINS) knownDomains.delete(knownDomains.keys().next().value ?? "");
  knownDomains.set(bare, site);
}

export const forgetRegistrableDomains = () => knownDomains.clear();

export function webOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const siteOfOrigin = (origin: string) => {
  const host = webOrigin(origin) ? new URL(origin).hostname : "";
  return host ? registrableDomain(host) : null;
};

export const coveredBy = (domain: string, domains: readonly string[]) => {
  const bare = domain.toLowerCase().replace(/^\.+/, "");
  return !!bare && domains.some((d) => bare === d || bare.endsWith(`.${d}`));
};

export function fingerprintOf(text: string): string {
  let low = 0x811c9dc5;
  let high = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    high = (high ^ (low >>> 15)) >>> 0;
  }
  return `${high.toString(36)}.${low.toString(36)}.${text.length.toString(36)}`;
}

export const cookieKey = (c: Pick<PageCookie, "name" | "domain" | "path">) => `${c.name}\u0001${c.domain.toLowerCase()}\u0001${c.path || "/"}`;
export const domainOfKey = (key: string) => key.split("\u0001")[1] ?? "";

export const cookieFingerprint = (c: PageCookie) => `${fingerprintOf(c.value)}|${c.session || !(c.expires > 0) ? "s" : Math.floor(c.expires / 60)}`;

export const usableCookie = (c: PageCookie, nowSeconds: number) =>
  !!c.name && !!c.domain && c.partitionKey == null && c.partitionKeyOpaque !== true && (c.session || !(c.expires > 0) || c.expires > nowSeconds);

export type Base = Record<string, string>;
export type Merged<T> = { put: [string, T][]; drop: [string, T][]; base: Base; conflicts: number; held: number };

export function mergeInto<T>(
  source: ReadonlyMap<string, T>,
  dest: ReadonlyMap<string, T>,
  base: Base,
  fingerprint: (item: T) => string,
  sourceWins: boolean,
  sourceDropsCount = true,
): Merged<T> {
  const next: Base = { ...base };
  const put: [string, T][] = [];
  const drop: [string, T][] = [];
  let conflicts = 0;
  let held = 0;
  const keys = new Set([...source.keys(), ...dest.keys(), ...Object.keys(base)]);
  for (const key of keys) {
    const s = source.get(key);
    const d = dest.get(key);
    const sf = s === undefined ? null : fingerprint(s);
    const df = d === undefined ? null : fingerprint(d);
    const bf = base[key] ?? null;
    if (sf === df) {
      if (sf === null) delete next[key];
      else next[key] = sf;
      continue;
    }
    if (sf === bf) continue;
    if (s === undefined && !sourceDropsCount) {
      held++;
      continue;
    }
    if (df !== bf) {
      conflicts++;
      if (!sourceWins) continue;
    }
    if (s !== undefined) put.push([key, s]);
    else if (d !== undefined) drop.push([key, d]);
    if (sf === null) delete next[key];
    else next[key] = sf;
  }
  return { put, drop, base: next, conflicts, held };
}

export function settledBase(before: Base, merged: Base, moved: readonly [string, unknown][], landed: boolean): Base {
  if (landed) return merged;
  const next = { ...merged };
  for (const [key] of moved) {
    if (before[key] === undefined) delete next[key];
    else next[key] = before[key];
  }
  return next;
}

export function scopedBase(base: Base, domains: readonly string[]): Base {
  const out: Base = {};
  for (const [key, value] of Object.entries(base)) if (coveredBy(domainOfKey(key), domains)) out[key] = value;
  return out;
}

export const cookieMap = (cookies: readonly PageCookie[], nowSeconds: number) => new Map(cookies.filter((c) => usableCookie(c, nowSeconds)).map((c) => [cookieKey(c), c]));
export const storageMap = (items: StorageItems) => new Map(items.map(([key, value]) => [key, value] as const));
export const storageFingerprint = (value: string) => fingerprintOf(value);

export function chromiumCookie(c: PageCookie): ChromiumCookieWrite {
  const path = c.path || "/";
  const hostOnly = !c.domain.startsWith(".");
  const host = c.domain.includes(":") && !c.domain.startsWith("[") ? `[${c.domain}]` : c.domain;
  const sameSite = c.sameSite === "None" && !c.secure ? undefined : c.sameSite;
  return {
    name: c.name,
    value: c.value,
    path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(hostOnly ? { url: `${c.secure ? "https" : "http"}://${host}${path}` } : { domain: c.domain }),
    ...(sameSite ? { sameSite } : {}),
    ...(c.session || !(c.expires > 0) ? {} : { expires: c.expires }),
  };
}

export const removal = (c: PageCookie): CookieRemoval => ({ name: c.name, domain: c.domain, path: c.path || "/" });
