import { punycodeEncode } from "@ardia/core";
import type { VaultItem } from "../../platform/vaults";
import { PUBLIC_SUFFIX_RULES } from "./suffixes";

type MatchTier = 0 | 1 | 2 | 3 | 4 | 5;
export const TIER = { none: 0, sibling: 1, subdomain: 2, www: 3, sameHost: 4, exact: 5 } as const;

type Site = { scheme: "http" | "https"; host: string; port: string; portGiven: boolean; schemeGiven: boolean };

const MAX_PORT = 65535;
const URL_HEAD = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d*))?/i;
const DEFAULT_PORT = { http: "80", https: "443" } as const;
const NON_ASCII = /[^\x00-\x7f]/;
const HOST_CHARS = /^[a-z0-9._:-]+$/;
const URL_EDGE_SPACE = /^[\x00-\x20]+|[\x00-\x20]+$/g;
const CACHE_LIMIT = 50_000;

type SuffixRules = { exact: Set<string>; wildcard: Set<string>; exception: Set<string> };
let suffixRules: SuffixRules | null = null;

function rules(): SuffixRules {
  if (suffixRules) return suffixRules;
  const built: SuffixRules = { exact: new Set(), wildcard: new Set(), exception: new Set() };
  for (const group of PUBLIC_SUFFIX_RULES.split(";")) {
    const at = group.indexOf(":");
    const tld = group.slice(0, at);
    for (const prefix of group.slice(at + 1).split(",")) {
      const rule = prefix ? `${prefix}.${tld}` : tld;
      if (rule.startsWith("!")) built.exception.add(rule.slice(1));
      else if (rule.startsWith("*.")) built.wildcard.add(rule.slice(2));
      else built.exact.add(rule);
    }
  }
  suffixRules = built;
  return built;
}

function remember<V>(cache: Map<string, V>, key: string, make: () => V): V {
  const known = cache.get(key);
  if (known !== undefined || cache.has(key)) return known as V;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const made = make();
  cache.set(key, made);
  return made;
}

const asciiHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.+$/, "")
    .split(".")
    .map((label) => (NON_ASCII.test(label) ? `xn--${punycodeEncode(label)}` : label))
    .join(".");

const parsedSites = new Map<string, Site | null>();

function parseUncached(url: string): Site | null {
  const text = url.replace(URL_EDGE_SPACE, "").replace(/\\/g, "/");
  if (!text) return null;
  const schemeGiven = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const m = URL_HEAD.exec(schemeGiven ? text : `https://${text}`);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const host = asciiHost(m[2]!);
  if (!host || !HOST_CHARS.test(host.replace(/^\[(.*)\]$/, "$1"))) return null;
  const portGiven = !!m[3];
  if (portGiven && Number(m[3]) > MAX_PORT) return null;
  return { scheme, host, port: portGiven ? String(Number(m[3])) : DEFAULT_PORT[scheme], portGiven, schemeGiven };
}

export const parseSite = (url: string): Site | null => remember(parsedSites, url, () => parseUncached(url));

const isIp = (host: string) => host.startsWith("[") || host.includes(":") || /^[\d.]+$/.test(host);
const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const bare = (host: string) => {
  if (!host.startsWith("www.")) return host;
  const rest = host.slice(4);
  const domain = registrableDomain(host);
  return domain && domain === registrableDomain(rest) ? rest : host;
};

export function publicSuffixOf(host: string): string {
  const { exact, wildcard, exception } = rules();
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (exception.has(candidate)) return labels.slice(i + 1).join(".");
    if (exact.has(candidate)) return candidate;
    if (i + 1 < labels.length && wildcard.has(labels.slice(i + 1).join("."))) return candidate;
  }
  return labels[labels.length - 1] ?? "";
}

const registrableDomains = new Map<string, string>();

function registrableUncached(host: string): string {
  const h = asciiHost(host);
  if (!h) return "";
  if (isIp(h) || isLocalHost(h)) return h;
  const suffix = publicSuffixOf(h);
  if (suffix === h) return "";
  const head = h.slice(0, h.length - suffix.length - 1);
  return `${head.slice(head.lastIndexOf(".") + 1)}.${suffix}`;
}

export const registrableDomain = (host: string): string => remember(registrableDomains, host, () => registrableUncached(host));

export function isSecureOrigin(origin: string): boolean {
  const site = parseSite(origin);
  return !!site && site.schemeGiven && (site.scheme === "https" || isLocalHost(site.host));
}

function portsMatch(page: Site, item: Site) {
  return item.portGiven ? item.port === page.port : page.port === DEFAULT_PORT[page.scheme];
}

function isLocalPortGuess(page: Site, item: Site) {
  return !item.portGiven && isLocalHost(page.host) && item.host === page.host && page.port !== DEFAULT_PORT[page.scheme];
}

function sameOrigin(page: Site, item: Site) {
  const scheme = item.schemeGiven ? item.scheme === page.scheme : page.scheme === "https" || isLocalHost(page.host);
  return scheme && (item.portGiven || page.port === DEFAULT_PORT[page.scheme]);
}

function tierOf(page: Site, pageSite: string, item: Site | null): MatchTier {
  if (!item) return TIER.none;
  if (isLocalPortGuess(page, item)) return TIER.sibling;
  if (!portsMatch(page, item)) return TIER.none;
  if (page.host === item.host) return sameOrigin(page, item) ? TIER.exact : TIER.sameHost;
  if (isIp(page.host) || isIp(item.host)) return TIER.none;
  const ph = bare(page.host);
  const ih = bare(item.host);
  if (ph === ih) return TIER.www;
  if (!pageSite || registrableDomain(ih) !== pageSite) return TIER.none;
  if (ph.endsWith(`.${ih}`) || ih.endsWith(`.${ph}`)) return TIER.subdomain;
  return TIER.sibling;
}

type Page = { site: Site; domain: string };

function pageOf(origin: string): Page | null {
  const site = parseSite(origin);
  if (!site || !isSecureOrigin(origin)) return null;
  return { site, domain: isIp(site.host) ? "" : registrableDomain(bare(site.host)) };
}

export function matchTier(pageOrigin: string, itemUrl: string): MatchTier {
  const page = pageOf(pageOrigin);
  return page ? tierOf(page.site, page.domain, parseSite(itemUrl)) : TIER.none;
}

type Matchable = Pick<VaultItem, "urls"> & { urlMatch?: VaultItem["urlMatch"] };
type ItemSite = { site: Site; domain: string; mode: string };

const itemSites = new WeakMap<Matchable, ItemSite[]>();

const capped = (tier: MatchTier, mode: string): MatchTier =>
  mode === "exact" ? (tier === TIER.exact ? tier : TIER.none) : mode === "host" ? (tier >= TIER.sameHost ? tier : TIER.none) : tier;

function sitesOf(item: Matchable) {
  let known = itemSites.get(item);
  if (!known) {
    known = [];
    const modes = item.urlMatch && item.urlMatch.length === item.urls.length ? item.urlMatch : null;
    item.urls.forEach((url, i) => {
      const site = parseSite(url);
      if (site) known!.push({ site, domain: isIp(site.host) ? site.host : registrableDomain(bare(site.host)) || site.host, mode: modes?.[i] ?? "" });
    });
    itemSites.set(item, known);
  }
  return known;
}

function tierOnPage(item: Matchable, page: Page): { tier: MatchTier; host: string; scheme: string } {
  let tier: MatchTier = TIER.none;
  let host = "";
  let scheme = "";
  for (const { site, domain, mode } of sitesOf(item)) {
    if (site.host !== page.site.host && domain !== page.domain) continue;
    const t = capped(tierOf(page.site, page.domain, site), mode);
    if (t > tier) {
      tier = t;
      host = bare(site.host);
      scheme = site.scheme;
    }
  }
  return { tier, host, scheme };
}

export const itemTier = (item: Matchable, origin: string): MatchTier => {
  const page = pageOf(origin);
  return page ? tierOnPage(item, page).tier : TIER.none;
};

export const fillsWithoutChoice = (item: Matchable, origin: string): boolean => itemTier(item, origin) >= TIER.subdomain;

type RankedItem = { item: VaultItem; tier: MatchTier };

export const itemKey = (item: Pick<VaultItem, "provider" | "id">) => `${item.provider}/${item.id}`;

const byRank = (preferred: string | null) => (a: RankedItem, b: RankedItem) =>
  b.tier - a.tier ||
  Number(itemKey(b.item) === preferred) - Number(itemKey(a.item) === preferred) ||
  a.item.username.localeCompare(b.item.username) ||
  a.item.title.localeCompare(b.item.title) ||
  (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0) ||
  a.item.provider.localeCompare(b.item.provider);

export function rankItems(items: readonly VaultItem[], origin: string, preferred: string | null = null): RankedItem[] {
  const page = pageOf(origin);
  if (!page) return [];
  const matched: (RankedItem & { host: string; scheme: string })[] = [];
  const pageHost = page.site.host;
  for (const item of items) {
    const sites = sitesOf(item);
    let near = false;
    for (let i = 0; i < sites.length && !near; i++) near = sites[i]!.domain === page.domain || sites[i]!.site.host === pageHost;
    if (!near) continue;
    const { tier, host, scheme } = tierOnPage(item, page);
    if (tier > TIER.none) matched.push({ item, tier, host, scheme });
  }
  matched.sort(byRank(preferred));
  const kept = new Map<string, { provider: string; scheme: string }[]>();
  const ranked: RankedItem[] = [];
  for (const { item, tier, host, scheme } of matched) {
    const login = `${item.username.trim().toLowerCase()}\n${host}`;
    const earlier = kept.get(login) ?? [];
    if (item.username.trim() && earlier.some((e) => e.provider !== item.provider || e.scheme !== scheme)) continue;
    earlier.push({ provider: item.provider, scheme });
    kept.set(login, earlier);
    ranked.push({ item, tier });
  }
  return ranked;
}

export const bestItem = (items: readonly VaultItem[], origin: string) => rankItems(items, origin).find((r) => r.tier >= TIER.subdomain)?.item ?? null;

export const sameUsername = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const loginSavedIn = (items: readonly VaultItem[], origin: string, username: string) =>
  items.some((item) => sameUsername(item.username, username) && itemTier(item, origin) >= TIER.sibling);

export function sameSite(a: string, b: string): boolean {
  const x = parseSite(a);
  const y = parseSite(b);
  if (!x || !y) return false;
  if (isIp(x.host) || isIp(y.host)) return x.host === y.host;
  const site = registrableDomain(x.host);
  return !!site && site === registrableDomain(y.host);
}

type SearchKey = { title: string; haystack: string; order: string };
const searchKeys = new WeakMap<VaultItem, SearchKey>();

const MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;

export const foldForSearch = (text: string) => text.normalize("NFKD").replace(MARKS, "").toLowerCase();

export const searchWordsOf = (query: string) => foldForSearch(query).split(/\s+/).filter(Boolean);

function searchKeyOf(item: VaultItem): SearchKey {
  let key = searchKeys.get(item);
  if (!key) {
    const title = foldForSearch(item.title);
    const username = foldForSearch(item.username);
    const hosts = item.urls.map((u) => parseSite(u)?.host ?? u.toLowerCase());
    key = { title, haystack: [title, username, ...hosts].join("\n"), order: `${title}\u0000${username}` };
    searchKeys.set(item, key);
  }
  return key;
}

export function searchItems(items: readonly VaultItem[], query: string, limit = 100): VaultItem[] {
  const words = searchWordsOf(query);
  const first = words[0] ?? "";
  const scored: { item: VaultItem; score: number; order: string }[] = [];
  for (const item of items) {
    const key = searchKeyOf(item);
    let all = true;
    for (let i = 0; i < words.length && all; i++) all = key.haystack.includes(words[i]!);
    if (!all) continue;
    scored.push({ item, score: !first ? 0 : key.title.startsWith(first) ? 2 : key.title.includes(first) ? 1 : 0, order: key.order });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .slice(0, limit)
    .map((s) => s.item);
}

export const siteLabel = (origin: string) => bare(parseSite(origin)?.host ?? origin);

export function siteKey(origin: string): string {
  const host = parseSite(origin)?.host;
  if (!host) return "";
  return registrableDomain(host) || host;
}
