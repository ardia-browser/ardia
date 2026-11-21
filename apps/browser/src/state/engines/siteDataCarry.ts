import { exportWebKitCookies, readWebKitSiteData, type SiteStorage, type StorageChange } from "../../platform/webkit";
import type { PageEngine } from "../../platform/tabs";
import { getSiteSettings } from "../../platform/siteSettings";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { tabEngine } from "./engines";
import {
  cookieFingerprint,
  cookieMap,
  knowsRegistrableDomain,
  mergeInto,
  registrableDomain,
  removal,
  scopedBase,
  settledBase,
  siteOfOrigin,
  storageFingerprint,
  storageMap,
  webOrigin,
} from "./siteDataMerge";
import { learnRegistrableDomains } from "./siteDataDomains";
import { readChromium, readChromiumStorageWithoutPage, writeChromium, writeChromiumStorageWithoutPage, writeWebKit } from "./siteDataChromium";
import { capBases, noteOrigin, needsCarry, profileOf, siteEntry, sourceIsNewer, touch } from "./siteDataLedger";
import { book, clearCount, clearsSettled, commitCount, committedSince, hostOf, inCommitLane, noteCommit, pushTimers, saveNow, saveSoon } from "./siteDataState";
import { noteSiteDataCarry, noteSiteDataOverQuota, noteSiteDataSkip, type SiteDataCarry } from "../telemetry/siteDataCounts";
import type { ConsentToken } from "../telemetry/client";

const WEBKIT_PURGE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const BLOCK_CACHE_MS = 60_000;
const BLOCK_CACHE_SIZE = 200;
const NOTHING: SiteDataCarry = { cookies: 0, removed: 0, storage: 0, conflicts: 0 };

const other = (engine: PageEngine): PageEngine => (engine === "webkit" ? "chromium" : "webkit");
const store = () => useBrowser.getState();

export const carriesSiteData = (s: Pick<BrowserState, "settings"> = store()) => s.settings.engineSwitchCarriesSiteData !== false;

type Live = { profile: string; site: string; engine: PageEngine; tabId: string };

export function liveTabs(s = store()): Live[] {
  const out: Live[] = [];
  for (const t of Object.values(s.tabs)) {
    if (isIncognitoProfile(t.profileId)) continue;
    const origin = t.url ? webOrigin(t.url) : null;
    const site = origin ? siteOfOrigin(origin) : null;
    if (site) out.push({ profile: engineProfile(s, t.profileId), site, engine: tabEngine(s, t.id), tabId: t.id });
  }
  return out;
}

export const openIn = (profile: string, site: string, engine: PageEngine) => liveTabs().some((l) => l.profile === profile && l.site === site && l.engine === engine);

const blockCache = new Map<string, { at: number; blocked: boolean }>();

async function cookiesBlocked(profile: string, origin: string): Promise<boolean> {
  const key = `${profile}|${origin}`;
  const cached = blockCache.get(key);
  if (cached && Date.now() - cached.at < BLOCK_CACHE_MS) return cached.blocked;
  const engines: PageEngine[] = ["chromium", "webkit"];
  const settings = await Promise.all(engines.map((engine) => getSiteSettings(profile, origin, engine).catch(() => null)));
  const blocked = settings.some((s) => s?.cookies?.value === "block");
  const now = Date.now();
  if (blockCache.size >= BLOCK_CACHE_SIZE) for (const [k, v] of blockCache) if (now - v.at >= BLOCK_CACHE_MS) blockCache.delete(k);
  if (blockCache.size >= BLOCK_CACHE_SIZE) blockCache.delete(blockCache.keys().next().value ?? "");
  blockCache.set(key, { at: now, blocked });
  return blocked;
}

export type CarryOptions = { origin?: string | null; stillWanted?: () => boolean; urgent?: boolean; consent: ConsentToken | null };

type UnderWay = { carry: Promise<SiteDataCarry>; wanted: () => boolean; urgent: boolean };

const underWay = new Map<string, UnderWay>();

export function carrySite(profile: string, site: string, to: PageEngine, options: CarryOptions): Promise<SiteDataCarry> {
  if (!carriesSiteData()) return Promise.resolve(NOTHING);
  const key = `${profile}|${site}|${to}`;
  const urgent = options.urgent ?? false;
  const wanted = options.stillWanted ?? (() => true);
  const running = underWay.get(key);
  if (running && running.wanted() && (running.urgent || !urgent)) return running.carry;
  const { consent } = options;
  const carry = clearsSettled(profile)
    .then(() => carryNow(profile, site, to, { ...options, urgent }))
    .catch(() => (noteSiteDataSkip("failure", consent), NOTHING))
    .finally(() => underWay.get(key)?.carry === carry && underWay.delete(key));
  underWay.set(key, { carry, wanted, urgent });
  return carry;
}

type Read = { chromium: Awaited<ReturnType<typeof readChromium>>; webkit: Awaited<ReturnType<typeof readWebKitSiteData>> | null };

const readBoth = async (profile: string, domains: string[], origins: string[]): Promise<Read> => {
  const [chromium, webkit] = await Promise.all([readChromium(profile, domains, origins), readWebKitSiteData(profile, domains, origins).catch(() => null)]);
  return { chromium, webkit };
};

const trustsDropsFrom = (from: PageEngine, lastUsed: number | undefined) => from === "chromium" || Date.now() - (lastUsed ?? 0) < WEBKIT_PURGE_WINDOW_MS;

async function carryNow(profile: string, site: string, to: PageEngine, { origin, stillWanted = () => true, urgent = false, consent }: CarryOptions): Promise<SiteDataCarry> {
  const cleared = clearCount(profile);
  const stillCurrent = () => stillWanted() && carriesSiteData() && clearCount(profile) === cleared;
  if (!stillCurrent()) return NOTHING;
  const entry = siteEntry(book(), profile, site);
  if (origin) noteOrigin(book(), profile, site, origin);
  const known = [...new Set([...(origin ? [origin] : []), ...entry.origins])];
  const candidates = [...new Set([site, ...entry.hops])];
  const [originBlocks, domainBlocks] = await Promise.all([
    Promise.all(known.map((o) => cookiesBlocked(profile, o))),
    Promise.all(candidates.map((d) => cookiesBlocked(profile, `https://${d}`))),
  ]);
  if (originBlocks[0]) {
    noteSiteDataSkip("blocked", consent);
    return NOTHING;
  }
  const origins = known.filter((_, i) => !originBlocks[i]);
  const domains = candidates.filter((_, i) => !domainBlocks[i]);
  if (!stillCurrent()) return NOTHING;
  const seen = commitCount(profile);
  const early = await readBoth(profile, domains, origins);
  if (!stillCurrent()) return NOTHING;
  return inCommitLane(profile, urgent, async () => {
    const read = committedSince(profile, seen, domains, origins) ? await readBoth(profile, domains, origins) : early;
    return commitCarry(profile, site, to, { entry, origins, domains, read, cleared, stillCurrent, consent });
  });
}

type Commit = {
  entry: ReturnType<typeof siteEntry>;
  origins: string[];
  domains: string[];
  read: Read;
  cleared: number;
  stillCurrent: () => boolean;
  consent: ConsentToken | null;
};

async function commitCarry(profile: string, site: string, to: PageEngine, { entry, origins, domains, read, cleared, stillCurrent, consent }: Commit): Promise<SiteDataCarry> {
  const from = other(to);
  const { chromium, webkit } = read;
  if (!webkit || !stillCurrent()) return NOTHING;
  const p = profileOf(book(), profile);
  const cookieBase = scopedBase(p.cookies, domains);
  const now = Date.now() / 1000;
  if (!chromium) {
    if (from === "chromium") {
      noteSiteDataSkip("chromiumUnreadable", consent);
      return NOTHING;
    }
    const changed = [...cookieMap(webkit.cookies, now)].filter(([key, c]) => cookieBase[key] !== cookieFingerprint(c)).map(([key]) => key);
    const urls = origins.map((o) => `${o}/`).concat(domains.map((d) => `https://${d}/`));
    const cookies = changed.length && stillCurrent() ? await exportWebKitCookies(profile, urls, changed).catch(() => 0) : 0;
    const stored = stillCurrent() ? await storageWithoutChromiumPage(profile, site, entry, origins, webkit.storage, cleared, stillCurrent, consent) : NO_ENGINE_STORAGE;
    if (!stored.available) noteSiteDataSkip("cookieOnlyFallback", consent);
    if (stored.failed) noteSiteDataSkip("failure", consent);
    const carry = { ...NOTHING, cookies, storage: stored.written, conflicts: stored.conflicts };
    if (cookies || stored.written) noteSiteDataCarry("chromium", carry, consent);
    return carry;
  }
  const source = from === "chromium" ? chromium.data : webkit;
  const dest = from === "chromium" ? webkit : chromium.data;
  const wins = sourceIsNewer(entry, to, openIn(profile, site, from), openIn(profile, site, to));
  const drops = trustsDropsFrom(from, entry.at[from]);
  const cookies = mergeInto(cookieMap(source.cookies, now), cookieMap(dest.cookies, now), cookieBase, cookieFingerprint, wins, drops);
  const storage: Record<string, StorageChange> = {};
  const storageMerges: { origin: string; before: Record<string, string>; merged: ReturnType<typeof mergeInto<string>> }[] = [];
  let conflicts = cookies.conflicts;
  let held = cookies.held;
  for (const o of origins) {
    const s = source.storage[o];
    const d = dest.storage[o];
    if (!s || !d) continue;
    const before = p.storage[o] ?? {};
    const merged = mergeInto(storageMap(s), storageMap(d), before, storageFingerprint, wins, drops);
    conflicts += merged.conflicts;
    held += merged.held;
    storageMerges.push({ origin: o, before, merged });
    if (merged.put.length || merged.drop.length) storage[o] = { set: merged.put, remove: merged.drop.map(([k]) => k) };
  }
  if (!stillCurrent()) return NOTHING;
  if (held) noteSiteDataSkip("untrustedDrops", consent);
  const putCookies = cookies.put.map(([, c]) => c);
  const dropCookies = cookies.drop.map(([, c]) => removal(c));
  const writing = putCookies.length + dropCookies.length + Object.keys(storage).length > 0;
  const written = !writing
    ? { cookies: 0, removed: 0, storage: 0, landed: new Set<string>() }
    : to === "webkit"
      ? await writeWebKit(profile, putCookies, dropCookies, storage)
      : await writeChromium(profile, chromium, putCookies, dropCookies, storage, stillCurrent);
  if (!written) {
    noteSiteDataSkip("failure", consent);
    return NOTHING;
  }
  if (writing) noteCommit(profile, domains, origins);
  if (clearCount(profile) !== cleared) return NOTHING;
  noteSiteDataOverQuota(written.overQuota ?? 0, consent);
  const cookiesLanded = written.cookies >= putCookies.length && written.removed >= dropCookies.length;
  const bases = profileOf(book(), profile);
  for (const k of Object.keys(cookieBase)) delete bases.cookies[k];
  Object.assign(bases.cookies, settledBase(cookieBase, cookies.base, [...cookies.put, ...cookies.drop], cookiesLanded));
  for (const { origin: o, before, merged } of storageMerges) bases.storage[o] = settledBase(before, merged.base, [...merged.put, ...merged.drop], !storage[o] || written.landed.has(o));
  entry.carried[to] = Date.now();
  capBases(bases);
  if (writing) saveNow(consent);
  else saveSoon(consent);
  const carry = { cookies: written.cookies, removed: written.removed, storage: written.storage, conflicts };
  noteSiteDataCarry(to, carry, consent);
  return carry;
}

type EngineStorageCarry = { available: boolean; written: number; conflicts: number; failed: boolean };
const NO_ENGINE_STORAGE: EngineStorageCarry = { available: false, written: 0, conflicts: 0, failed: false };

async function storageWithoutChromiumPage(
  profile: string,
  site: string,
  entry: Commit["entry"],
  origins: string[],
  webkitStorage: SiteStorage,
  cleared: number,
  stillCurrent: () => boolean,
  consent: ConsentToken | null,
): Promise<EngineStorageCarry> {
  const wanted = origins.filter((o) => webkitStorage[o]);
  if (!wanted.length) return { ...NO_ENGINE_STORAGE, available: true };
  const chromiumStorage = await readChromiumStorageWithoutPage(profile, wanted);
  const available = wanted.some((o) => chromiumStorage[o]);
  if (!available || !stillCurrent()) return { ...NO_ENGINE_STORAGE, available };
  const p = profileOf(book(), profile);
  const wins = sourceIsNewer(entry, "chromium", openIn(profile, site, "webkit"), openIn(profile, site, "chromium"));
  const drops = trustsDropsFrom("webkit", entry.at.webkit);
  const storage: Record<string, StorageChange> = {};
  const merges: { origin: string; before: Record<string, string>; merged: ReturnType<typeof mergeInto<string>> }[] = [];
  let conflicts = 0;
  let held = 0;
  for (const o of wanted) {
    const s = webkitStorage[o];
    const d = chromiumStorage[o];
    if (!s || !d) continue;
    const before = p.storage[o] ?? {};
    const merged = mergeInto(storageMap(s), storageMap(d), before, storageFingerprint, wins, drops);
    conflicts += merged.conflicts;
    held += merged.held;
    merges.push({ origin: o, before, merged });
    if (merged.put.length || merged.drop.length) storage[o] = { set: merged.put, remove: merged.drop.map(([k]) => k) };
  }
  if (!merges.length || !stillCurrent()) return { ...NO_ENGINE_STORAGE, available };
  if (held) noteSiteDataSkip("untrustedDrops", consent);
  const writing = Object.keys(storage).length > 0;
  const written = writing ? await writeChromiumStorageWithoutPage(profile, storage, stillCurrent) : { storage: 0, landed: new Set<string>(), overQuota: 0 };
  if (writing) noteCommit(profile, [], Object.keys(storage));
  noteSiteDataOverQuota(written.overQuota, consent);
  if (clearCount(profile) !== cleared) return { ...NO_ENGINE_STORAGE, available };
  const bases = profileOf(book(), profile);
  for (const { origin: o, before, merged } of merges) bases.storage[o] = settledBase(before, merged.base, [...merged.put, ...merged.drop], !storage[o] || written.landed.has(o));
  capBases(bases);
  if (writing) saveNow(consent);
  else saveSoon(consent);
  const failed = Object.keys(storage).some((o) => !written.landed.has(o));
  return { available, written: written.storage, conflicts, failed };
}

export async function carryForTab(tabId: string, url: string, to: PageEngine, stillWanted: () => boolean, consent: ConsentToken | null): Promise<number> {
  const s = store();
  const t = s.tabs[tabId];
  const origin = webOrigin(url);
  if (!t || !origin || isIncognitoProfile(t.profileId)) return 0;
  const profile = engineProfile(s, t.profileId);
  await learnRegistrableDomains([hostOf(origin)]);
  const site = siteOfOrigin(origin);
  if (!site) return 0;
  const wanted = () => {
    const now = store();
    const tab = now.tabs[tabId];
    return stillWanted() && !!tab && !isIncognitoProfile(tab.profileId) && engineProfile(now, tab.profileId) === profile;
  };
  const carried = await carrySite(profile, site, to, { origin, stillWanted: wanted, urgent: true, consent });
  return carried.cookies;
}

export async function carryRecentSites(to: PageEngine, consent: ConsentToken | null, stillWanted: () => boolean = () => true, limit = 30): Promise<void> {
  const from = other(to);
  const jobs: { profile: string; site: string; at: number }[] = [];
  for (const [profile, p] of Object.entries(book()))
    for (const [site, entry] of Object.entries(p.sites)) if (needsCarry(entry, to, false) && (entry.at[from] ?? 0) > 0) jobs.push({ profile, site, at: entry.at[from] ?? 0 });
  jobs.sort((a, b) => b.at - a.at);
  for (const job of jobs.slice(0, limit)) {
    if (!stillWanted()) return;
    await carrySite(job.profile, job.site, to, { stillWanted, consent });
  }
}

export async function prepareWebKitLoad(profile: string, origin: string, consent: ConsentToken | null): Promise<{ carry: Promise<SiteDataCarry> } | null> {
  if (!carriesSiteData() || !webOrigin(origin)) return null;
  await learnRegistrableDomains([hostOf(origin)]);
  if (!knowsRegistrableDomain(hostOf(origin))) noteSiteDataSkip("siteUnresolved", consent);
  const site = siteOfOrigin(origin);
  if (!site) return null;
  const entry = book()[profile]?.sites[site];
  const open = openIn(profile, site, "chromium");
  if (!needsCarry(entry, "webkit", open)) {
    touch(book(), profile, site, "webkit", Date.now(), origin);
    return null;
  }
  return { carry: carrySite(profile, site, "webkit", { origin, urgent: true, consent }) };
}

export function carrySoon(profile: string, site: string, to: PageEngine, delay: number, consent: ConsentToken | null) {
  const key = `${profile}|${site}|${to}`;
  if (pushTimers.has(key)) clearTimeout(pushTimers.get(key));
  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key);
      void carrySite(profile, site, to, { consent });
    }, delay),
  );
}

export const pushSoon = (profile: string, site: string, delay: number, consent: ConsentToken | null) => carrySoon(profile, site, "chromium", delay, consent);

export function webKitInUse(profile: string, s = store()): boolean {
  if (s.settings.engineMode === "webkit" || Object.values(s.settings.websiteEngines ?? {}).includes("webkit")) return true;
  return Object.values(book()[profile]?.sites ?? {}).some((e) => !!e.at.webkit);
}

export function knownSites(profile: string, domains: string[]): string[] {
  const p = book()[profile];
  if (!p) return [];
  const found = new Set<string>();
  for (const domain of domains) {
    const site = registrableDomain(domain);
    if (p.sites[site]) found.add(site);
    for (const [name, entry] of Object.entries(p.sites)) if (entry.at.webkit && entry.hops.includes(site)) found.add(name);
  }
  return [...found].slice(0, 20);
}

export function resetCarriesForTest() {
  blockCache.clear();
  underWay.clear();
}
