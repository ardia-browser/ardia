import type { PageEngine } from "../../platform/tabs";
import type { Base } from "./siteDataMerge";

export type SiteEntry = {
  at: Partial<Record<PageEngine, number>>;
  carried: Partial<Record<PageEngine, number>>;
  origins: string[];
  hops: string[];
};

export type ProfileLedger = { sites: Record<string, SiteEntry>; cookies: Base; storage: Record<string, Base> };
export type Ledger = Record<string, ProfileLedger>;

const MAX_SITES = 400;
const MAX_ORIGINS = 6;
const MAX_HOPS = 6;
const MAX_COOKIE_KEYS = 20_000;
const MAX_STORAGE_ORIGINS = 400;
const TOUCH_STEP_MS = 5_000;

const EMPTY: SiteEntry = { at: {}, carried: {}, origins: [], hops: [] };
const other = (engine: PageEngine): PageEngine => (engine === "webkit" ? "chromium" : "webkit");

export const emptyProfile = (): ProfileLedger => ({ sites: {}, cookies: {}, storage: {} });

export function profileOf(ledger: Ledger, profile: string): ProfileLedger {
  return (ledger[profile] ??= emptyProfile());
}

export function siteEntry(ledger: Ledger, profile: string, site: string): SiteEntry {
  const sites = profileOf(ledger, profile).sites;
  return (sites[site] ??= { at: {}, carried: {}, origins: [], hops: [] });
}

const pushCapped = (list: string[], value: string, cap: number) => {
  if (list.includes(value)) return false;
  list.push(value);
  if (list.length > cap) list.splice(0, list.length - cap);
  return true;
};

export function touch(ledger: Ledger, profile: string, site: string, engine: PageEngine, now: number, origin?: string | null): boolean {
  const entry = siteEntry(ledger, profile, site);
  let changed = false;
  const last = entry.at[engine] ?? 0;
  if (now - last >= TOUCH_STEP_MS || now < last) {
    entry.at[engine] = now;
    changed = true;
  }
  if (origin && pushCapped(entry.origins, origin, MAX_ORIGINS)) changed = true;
  if (changed) trimSites(profileOf(ledger, profile));
  return changed;
}

export const noteOrigin = (ledger: Ledger, profile: string, site: string, origin: string) => pushCapped(siteEntry(ledger, profile, site).origins, origin, MAX_ORIGINS);

export const addHop = (ledger: Ledger, profile: string, site: string, hop: string) => site !== hop && pushCapped(siteEntry(ledger, profile, site).hops, hop, MAX_HOPS);

export function needsCarry(entry: SiteEntry | undefined, to: PageEngine, openInSource: boolean): boolean {
  if (openInSource || !entry || entry.carried[to] === undefined) return true;
  return (entry.at[other(to)] ?? 0) > entry.carried[to];
}

export function sourceIsNewer(entry: SiteEntry | undefined, to: PageEngine, openInSource: boolean, openInDest: boolean): boolean {
  if (openInSource !== openInDest) return openInSource;
  return (entry?.at[other(to)] ?? 0) >= (entry?.at[to] ?? 0);
}

const recent = (s: SiteEntry) => Math.max(s.at.chromium ?? 0, s.at.webkit ?? 0, s.carried.chromium ?? 0, s.carried.webkit ?? 0);

function trimSites(p: ProfileLedger) {
  const names = Object.keys(p.sites);
  if (names.length <= MAX_SITES) return;
  names.sort((a, b) => recent(p.sites[a] ?? EMPTY) - recent(p.sites[b] ?? EMPTY));
  for (const name of names.slice(0, names.length - MAX_SITES)) delete p.sites[name];
}

const hostOfOrigin = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
};

function reachOwners(p: ProfileLedger): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [site, entry] of Object.entries(p.sites))
    for (const domain of new Set([site, ...entry.hops])) {
      const list = owners.get(domain);
      if (list) list.push(site);
      else owners.set(domain, [site]);
    }
  return owners;
}

function ownersOf(domain: string, owners: Map<string, string[]>): string[] {
  const found: string[] = [];
  let rest = domain.toLowerCase().replace(/^\.+/, "");
  while (rest) {
    const list = owners.get(rest);
    if (list) found.push(...list);
    const dot = rest.indexOf(".");
    rest = dot < 0 ? "" : rest.slice(dot + 1);
  }
  return found;
}

type Held = { cookies: string[]; origins: string[]; owners: Set<string> };

function heldByDomain(p: ProfileLedger, owners: Map<string, string[]>): Held[] {
  const groups = new Map<string, Held>();
  const groupOf = (domain: string) => {
    let group = groups.get(domain);
    if (!group) {
      group = { cookies: [], origins: [], owners: new Set(ownersOf(domain, owners)) };
      groups.set(domain, group);
    }
    return group;
  };
  for (const key of Object.keys(p.cookies)) {
    const start = key.indexOf("\u0001") + 1;
    const stop = key.indexOf("\u0001", start);
    groupOf(key.slice(start, stop < 0 ? undefined : stop)).cookies.push(key);
  }
  for (const origin of Object.keys(p.storage)) groupOf(hostOfOrigin(origin)).origins.push(origin);
  return [...groups.values()];
}

const overCap = (p: ProfileLedger) => Object.keys(p.cookies).length > MAX_COOKIE_KEYS || Object.keys(p.storage).length > MAX_STORAGE_ORIGINS;

export function capBases(p: ProfileLedger) {
  if (!overCap(p)) return;
  let cookies = Object.keys(p.cookies).length;
  let origins = Object.keys(p.storage).length;
  const drop = (group: Held) => {
    for (const key of group.cookies) delete p.cookies[key];
    for (const origin of group.origins) delete p.storage[origin];
    cookies -= group.cookies.length;
    origins -= group.origins.length;
  };
  const stillOver = () => cookies > MAX_COOKIE_KEYS || origins > MAX_STORAGE_ORIGINS;
  const bySite = new Map<string, Held[]>();
  const liveOwners = new Map<Held, number>();
  for (const group of heldByDomain(p, reachOwners(p))) {
    if (!group.owners.size) {
      drop(group);
      continue;
    }
    liveOwners.set(group, group.owners.size);
    for (const site of group.owners) {
      const list = bySite.get(site);
      if (list) list.push(group);
      else bySite.set(site, [group]);
    }
  }
  const names = Object.keys(p.sites).sort((a, b) => recent(p.sites[a] ?? EMPTY) - recent(p.sites[b] ?? EMPTY));
  for (const name of names) {
    if (!stillOver()) return;
    delete p.sites[name];
    for (const group of bySite.get(name) ?? []) {
      const left = (liveOwners.get(group) ?? 1) - 1;
      liveOwners.set(group, left);
      if (left === 0) drop(group);
    }
  }
}

export function forgetSessionCookies(ledger: Ledger) {
  for (const p of Object.values(ledger)) for (const [key, fingerprint] of Object.entries(p.cookies)) if (fingerprint.endsWith("|s")) delete p.cookies[key];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, cap: number) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(-cap) : []);
const times = (v: unknown): Partial<Record<PageEngine, number>> => {
  const out: Partial<Record<PageEngine, number>> = {};
  if (!isRecord(v)) return out;
  for (const engine of ["chromium", "webkit"] as const) if (typeof v[engine] === "number" && Number.isFinite(v[engine])) out[engine] = v[engine] as number;
  return out;
};
const base = (v: unknown): Base => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {});

export function readLedger(raw: unknown): Ledger {
  const ledger: Ledger = {};
  if (!isRecord(raw)) return ledger;
  for (const [profile, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const p = emptyProfile();
    if (isRecord(value.sites))
      for (const [site, entry] of Object.entries(value.sites)) {
        if (!isRecord(entry)) continue;
        p.sites[site] = { at: times(entry.at), carried: times(entry.carried), origins: strings(entry.origins, MAX_ORIGINS), hops: strings(entry.hops, MAX_HOPS) };
      }
    p.cookies = base(value.cookies);
    if (isRecord(value.storage)) for (const [origin, keys] of Object.entries(value.storage)) p.storage[origin] = base(keys);
    trimSites(p);
    capBases(p);
    ledger[profile] = p;
  }
  return ledger;
}
